const oauthService = require('../services/shopify/shopifyOAuth.service');
const connectionService = require('../services/shopify/shopifyConnection.service');
const tokenService = require('../services/shopify/shopifyToken.service');
const shopifyGraphql = require('../services/shopify/shopifyGraphql.service');
const syncService = require('../services/shopify/shopifySync.service');
const syncJobs = require('../services/shopify/shopifySyncJobs.service');
const productMap = require('../services/shopify/shopifyProductMap.service');
const { getDistinctPricelists } = require('../services/customExport.service');
const { verifyWebhookHmac } = require('../services/shopify/crypto.service');

/**
 * Controller for the Shopify connection lifecycle (design §10).
 * OAuth: connect → callback. Management: status, config, disconnect. Plus webhooks.
 */

const ERROR_STATUS_MAP = {
    VALIDATION_ERROR: 400,
    INVALID_ID: 400,
    NO_LOCATION: 400,
    NO_EXPORT_CONFIG: 400,
    INVALID_HMAC: 401,
    INVALID_STATE: 401,
    REAUTH_REQUIRED: 401,
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    NOT_ACTIVE: 409,
    SYNC_BUSY: 409,
    SERVER_ERROR: 500
};

/**
 * A run does several things at once (stock + create + content + images). Pick the most
 * salient label for the activity "Type" column instead of always showing "Inventory".
 */
function runTypeLabel(c) {
    if (c.createdProducts) return 'Create';
    if (c.imagesPushed) return 'Images';
    if (c.pricesPushed || c.contentPushed) return 'Content';
    return 'Stock';
}

/** Shapes a stored sync-run document into the row the partner UI's activity table renders. */
function toActivityRow(job) {
    const c = job.counts || {};
    const label = (c.inScope || 0) === 0
        ? 'Nothing in scope'
        : `${c.pushed || 0}/${c.matched || 0} stock`;
    const bits = [];
    if (job.error) bits.push(job.error);
    if (c.createdProducts) bits.push(`${c.createdProducts} created`);
    if (c.pricesPushed) bits.push(`${c.pricesPushed} prices`);
    if (c.contentPushed) bits.push(`${c.contentPushed} content`);
    if (c.imagesPushed) bits.push(`${c.imagesPushed} images`);
    if (c.unmatched) bits.push(`${c.unmatched} unmatched`);
    if (c.failed) bits.push(`${c.failed} failed`);
    const detail = bits.length ? bits.join(' · ') : (job.trigger || null);
    return {
        id: job._id.toString(),
        type: runTypeLabel(c),
        status: job.status,
        attempts: job.attempts || 1,
        time: (job.finishedAt || job.startedAt || job.createdAt)?.toISOString?.() || null,
        label,
        detail,
        trigger: job.trigger
    };
}

function handleError(res, error) {
    const status = ERROR_STATUS_MAP[error.code] || 500;
    if (status === 500) console.error('[shopify] error:', error);
    res.status(status).json({ success: false, error: error.message, code: error.code || 'SERVER_ERROR' });
}

/** Resolves the portal user (Auth0 sub/email) from the verified JWT. */
function authUser(req) {
    return { sub: req.auth?.payload?.sub, email: req.auth?.payload?.email };
}

/**
 * GET /shopify/connect?shop= — start OAuth. Returns the Shopify authorize URL for the
 * browser to redirect to (the UI does `window.location = url`).
 */
exports.connect = async (req, res) => {
    try {
        const { sub, email } = authUser(req);
        const { url, shop } = oauthService.buildInstallUrl({ shopInput: req.query.shop, sub, email });
        res.json({ success: true, url, shop });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /shopify/callback — OAuth redirect target. Verifies, persists, then 302s the browser
 * back to the portal UI. On error, redirects with a `?shopify=error` flag rather than a raw 500
 * (it's a user-facing browser navigation, not an API call).
 */
exports.callback = async (req, res) => {
    const returnUrl = process.env.SHOPIFY_PORTAL_RETURN_URL || '/';
    try {
        const { connection, webhooks } = await oauthService.handleCallback(req.query);
        const sep = returnUrl.includes('?') ? '&' : '?';
        let target = `${returnUrl}${sep}shopify=connected&shop=${encodeURIComponent(connection.shopDomain)}`;
        if (webhooks.failed.length) target += '&webhooks=partial';
        res.redirect(target);
    } catch (error) {
        console.error('[shopify] callback failed:', error.code || '', error.message);
        const sep = returnUrl.includes('?') ? '&' : '?';
        res.redirect(`${returnUrl}${sep}shopify=error&reason=${encodeURIComponent(error.code || 'SERVER_ERROR')}`);
    }
};

/**
 * GET /shopify/status — current user's connection (or null), plus the shop's inventory
 * locations when connected (best-effort; an empty list is not an error).
 */
exports.status = async (req, res) => {
    try {
        const { sub } = authUser(req);
        const connection = await connectionService.getConnectionForUser(sub);
        if (!connection) {
            return res.json({ success: true, connected: false, connection: null, locations: [], needsReconnect: false });
        }

        // `needsReconnect` tells the UI to prompt a re-install — set when the stored token can't
        // be refreshed (legacy non-expiring token, or an expired refresh token).
        let locations = [];
        let needsReconnect = connection.status === 'error';
        if (connection.status === 'active') {
            try {
                const token = await tokenService.getValidAccessToken(connection._id);
                locations = await shopifyGraphql.listLocations(connection.shopDomain, token);
            } catch (err) {
                if (err.code === 'REAUTH_REQUIRED') needsReconnect = true;
                else console.error('[shopify] listLocations failed:', err.code || '', err.message);
            }
        }

        res.json({ success: true, connected: connection.status === 'active', connection, locations, needsReconnect });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /shopify/pricelists — distinct named pricelists across the catalogue, so the pricing
 * panel seeds its priority list from real pricelist names (mirrors the /export builder).
 */
exports.pricelists = async (req, res) => {
    try {
        const pricelists = await getDistinctPricelists();
        res.json({ success: true, pricelists });
    } catch (error) {
        handleError(res, error);
    }
};

/** Loads a connection and asserts the JWT user owns it, else throws FORBIDDEN/NOT_FOUND. */
async function loadOwned(req) {
    const { sub } = authUser(req);
    const connection = await connectionService.getConnectionById(req.params.id);
    if (!connection) {
        const error = new Error('Connection not found');
        error.code = 'NOT_FOUND';
        throw error;
    }
    if (connection.ownerSub !== sub) {
        const error = new Error('You do not own this connection');
        error.code = 'FORBIDDEN';
        throw error;
    }
    return connection;
}

/**
 * PUT /shopify/connection/:id/config — update sync config / location for an owned connection.
 */
exports.updateConfig = async (req, res) => {
    try {
        await loadOwned(req);
        const updated = await connectionService.updateConnectionConfig(req.params.id, req.body || {});

        // Initial push (design §8.1): the first time a connection becomes sync-ready (products +
        // location chosen) and has never synced, kick off a sync so the partner doesn't have to
        // click "Sync now" for the very first run. Fire-and-forget; SYNC_BUSY guards re-saves.
        if (updated.config?.exportConfigId && updated.shopifyLocationId && !updated.lastSyncAt) {
            syncService.startStockSync(updated._id, { trigger: 'initial' }).catch(() => {});
        }

        res.json({ success: true, data: updated });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * POST /shopify/connection/:id/sync — manual "Sync now" (Phase A: stock-only).
 * Owner-checked. Starts the run in the background and responds 202 with the run id so the
 * UI can poll `/activity`; the heavy push proceeds under the per-shop queue lock.
 */
exports.sync = async (req, res) => {
    try {
        const connection = await loadOwned(req);
        const job = await syncService.startStockSync(connection._id, { trigger: 'manual' });
        res.status(202).json({ success: true, job: toActivityRow(job) });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /shopify/connection/:id/activity — recent sync runs + aggregate map counts + the
 * latest run's unmatched "needs attention" list. Owner-checked. Replaces the UI's three
 * MOCK_* constants with live data.
 */
exports.activity = async (req, res) => {
    try {
        const connection = await loadOwned(req);
        const [runs, stateCounts, latest] = await Promise.all([
            syncJobs.listRecentRuns(connection._id, 20),
            productMap.getStateCounts(connection._id),
            syncJobs.getLatestRun(connection._id)
        ]);
        res.json({
            success: true,
            jobs: runs.map(toActivityRow),
            // synced/error come from the authoritative map; pending = SKUs the latest run
            // couldn't match yet (awaiting a fix or a future create phase).
            counts: {
                synced: stateCounts.synced,
                pending: latest?.counts?.unmatched || 0,
                error: stateCounts.error
            },
            unmatched: latest?.unmatched || []
        });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * DELETE /shopify/connection/:id — disconnect (delete the stored token + connection).
 * Note: this removes our record; it does not uninstall the app from the merchant's side.
 */
exports.disconnect = async (req, res) => {
    try {
        const connection = await loadOwned(req);
        await connectionService.deleteConnection(req.params.id);
        // Drop the now-orphaned product map so a later reinstall re-matches cleanly.
        await productMap.deleteForConnection(connection._id);
        res.json({ success: true, message: 'Disconnected' });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * POST /shopify/webhooks — single HMAC-verified endpoint for all topics; dispatches by the
 * `X-Shopify-Topic` header. Always responds 200 quickly (Shopify retries on non-2xx); the
 * GDPR topics are acknowledged even though this is a one-way push app holding no customer data.
 */
exports.webhook = async (req, res) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shopDomain = req.get('X-Shopify-Shop-Domain');

    if (!verifyWebhookHmac(req.rawBody, hmac)) {
        return res.status(401).json({ message: 'Invalid webhook HMAC' });
    }

    try {
        switch (topic) {
            case 'app/uninstalled':
                await connectionService.markUninstalledByShop(shopDomain);
                console.log(`[shopify] app uninstalled: ${shopDomain}`);
                break;
            case 'shop/redact':
            case 'customers/redact':
            case 'customers/data_request':
                // One-way push app — we store no Shopify customer data. Acknowledge per GDPR.
                console.log(`[shopify] GDPR webhook ${topic} for ${shopDomain} — no data held`);
                break;
            default:
                console.log(`[shopify] unhandled webhook topic: ${topic}`);
        }
    } catch (err) {
        // Log but still 200 — a thrown error would make Shopify retry a non-recoverable case.
        console.error(`[shopify] webhook handler error (${topic}):`, err.message);
    }
    res.status(200).json({ received: true });
};
