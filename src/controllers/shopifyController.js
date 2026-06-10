const oauthService = require('../services/shopify/shopifyOAuth.service');
const connectionService = require('../services/shopify/shopifyConnection.service');
const tokenService = require('../services/shopify/shopifyToken.service');
const shopifyApi = require('../services/shopify/shopifyApi.service');
const shopifyGraphql = require('../services/shopify/shopifyGraphql.service');
const syncService = require('../services/shopify/shopifySync.service');
const syncJobs = require('../services/shopify/shopifySyncJobs.service');
const productMap = require('../services/shopify/shopifyProductMap.service');
const { getDistinctPricelists } = require('../services/customExport.service');
const { verifyOAuthHmac, verifyWebhookHmac } = require('../services/shopify/crypto.service');

/**
 * Controller for the Shopify connection lifecycle (design §10).
 * OAuth: connect → callback. Management: status, config, disconnect. Plus webhooks.
 */

const ERROR_STATUS_MAP = {
    VALIDATION_ERROR: 400,
    BAD_REQUEST: 400,
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
 * The activity "Type" column shows HOW the run pushed — the ownership mode of its source(s):
 * Stock only / Create + handoff / Portal authoritative, or "Mixed" when a multi-source run
 * combined different modes. Falls back to the old what-it-did label for legacy runs recorded
 * before per-scope summaries existed.
 */
const OWNERSHIP_TYPE_LABEL = {
    stock_only: 'Stock',
    create_then_handoff: 'Create + handoff',
    portal_authoritative: 'Portal authoritative'
};

function runTypeLabel(job) {
    const owns = [...new Set((job.scopes || []).map((s) => s.ownership).filter(Boolean))];
    if (owns.length > 1) return 'Mixed';
    if (owns.length === 1) return OWNERSHIP_TYPE_LABEL[owns[0]] || owns[0];
    const c = job.counts || {};
    if (c.createdProducts) return 'Create';
    if (c.imagesPushed || c.variantImagesLinked) return 'Images';
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
    if (c.variantImagesLinked) bits.push(`${c.variantImagesLinked} variant images`);
    if (c.publishedProducts) bits.push(`${c.publishedProducts} published`);
    if (c.unmatched) bits.push(`${c.unmatched} unmatched`);
    if (c.failed) bits.push(`${c.failed} failed`);
    const detail = bits.length ? bits.join(' · ') : (job.trigger || null);
    return {
        id: job._id.toString(),
        type: runTypeLabel(job),
        status: job.status,
        attempts: job.attempts || 1,
        time: (job.finishedAt || job.startedAt || job.createdAt)?.toISOString?.() || null,
        label,
        detail,
        trigger: job.trigger,
        // Full per-run data for the UI's run-detail modal (the row fields above stay compact).
        startedAt: job.startedAt?.toISOString?.() || null,
        finishedAt: job.finishedAt?.toISOString?.() || null,
        counts: c,
        scopes: job.scopes || [],
        error: job.error || null,
        errors: (job.errors || []).slice(0, 100)
    };
}

/**
 * Groups tombstoned (deleted-in-store) map rows by their parent product — Shopify deletion is
 * per-product, so the partner acts on the parent, not each variant SKU. Each group carries the
 * variant SKUs, when it was first seen gone, and whether a recreate is already queued.
 */
function groupDeletedByParent(rows) {
    const byParent = new Map();
    for (const r of rows || []) {
        const key = r.parentCode || r.sku;
        let g = byParent.get(key);
        if (!g) {
            g = { parentCode: r.parentCode || null, skus: [], deletedInStoreAt: null, recreateRequested: false };
            byParent.set(key, g);
        }
        g.skus.push(r.sku);
        if (r.recreateRequested) g.recreateRequested = true;
        const ts = r.deletedInStoreAt?.toISOString?.() || null;
        if (ts && (!g.deletedInStoreAt || ts < g.deletedInStoreAt)) g.deletedInStoreAt = ts;
    }
    return [...byParent.values()].sort((a, b) => (a.deletedInStoreAt || '').localeCompare(b.deletedInStoreAt || ''));
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
 * GET /shopify/entry — the app's **App URL** (the entry point Shopify loads when a merchant
 * opens the app from their admin). Shopify appends a signed query (`shop`, `hmac`, `host`,
 * `timestamp`, `session`). This app is **non-embedded** and **portal-first**, so the entry point
 * doesn't render an app — it verifies the signature and routes the browser to the portal:
 *   • shop already connected → open the portal on that store;
 *   • shop not connected yet → open the portal's connect screen with the domain prefilled, where
 *     the partner signs in (Auth0) and approves the install (binding the store to their account).
 * It never renders a raw gated page — that's what App-Store reviewers test on a fresh store.
 */
exports.entry = async (req, res) => {
    const returnUrl = process.env.SHOPIFY_PORTAL_RETURN_URL || '/';
    const sep = returnUrl.includes('?') ? '&' : '?';
    try {
        // The request must be a genuine, untampered Shopify call before we trust `shop`.
        if (!verifyOAuthHmac(req.query)) {
            return res.status(400).send('Invalid request signature.');
        }
        const shop = oauthService.normalizeShopDomain(req.query.shop);
        if (!shop) return res.status(400).send('Invalid shop parameter.');

        const existing = await connectionService.findByShopDomain(shop);
        if (existing) {
            return res.redirect(`${returnUrl}${sep}shop=${encodeURIComponent(shop)}`);
        }
        return res.redirect(`${returnUrl}${sep}connect=1&shop=${encodeURIComponent(shop)}`);
    } catch (error) {
        console.error('[shopify] entry failed:', error.message);
        return res.redirect(`${returnUrl}${sep}shopify=error&reason=entry_failed`);
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
 * Loads a connection's LIVE shop data — inventory locations + sales channels (publications) +
 * whether the token can publish + whether a reconnect is needed. Best-effort: a failed Shopify
 * call yields empty lists, never an error (except surfacing `needsReconnect`). Shared by the
 * legacy single-store `status` and the per-store `connectionDetail` endpoints.
 */
async function loadLiveShopData(connection) {
    let locations = [];
    let publications = [];
    // Whether the granted token can publish to sales channels. Connections made before the
    // publications scopes were added won't have them → UI prompts a reconnect to enable it.
    const publishingEnabled = connectionService.canPublish(connection);
    // `needsReconnect` tells the UI to prompt a re-install — set when the stored token can't be
    // refreshed (legacy non-expiring token, or an expired refresh token).
    let needsReconnect = connection.status === 'error';
    if (connection.status === 'active') {
        try {
            const token = await tokenService.getValidAccessToken(connection._id);
            locations = await shopifyGraphql.listLocations(connection.shopDomain, token);
            if (publishingEnabled) {
                try {
                    publications = await shopifyGraphql.listPublications(connection.shopDomain, token);
                } catch (err) {
                    console.error('[shopify] listPublications failed:', err.message);
                }
            }
        } catch (err) {
            // A 401 on a token we believe is valid means it's been revoked — i.e. the app was
            // uninstalled in Shopify. The `app/uninstalled` webhook may never have reached us
            // (Shopify can't POST to a localhost/unreachable dev API), so detect it lazily here
            // and mirror exactly what the webhook does: mark the connection uninstalled (hides it
            // from the portal list) and drop its product map. The UI removes it from the switcher.
            if (err.code === 'SHOPIFY_AUTH' && err.status === 401) {
                try {
                    const ids = await connectionService.markUninstalledByShop(connection.shopDomain);
                    await Promise.all(ids.map((id) => productMap.deleteForConnection(id)));
                    console.log(`[shopify] detected uninstall on load: ${connection.shopDomain} (${ids.length} connection(s))`);
                } catch (markErr) {
                    console.error('[shopify] failed to mark uninstalled:', markErr.message);
                }
                return { locations: [], publications: [], publishingEnabled: false, needsReconnect: false, uninstalled: true };
            }
            if (err.code === 'REAUTH_REQUIRED') needsReconnect = true;
            else console.error('[shopify] listLocations failed:', err.code || '', err.message);
        }
    }
    return { locations, publications, publishingEnabled, needsReconnect };
}

/**
 * GET /shopify/status — current user's connection (or null), plus the shop's inventory
 * locations when connected (best-effort; an empty list is not an error). Legacy single-store
 * shape; the multi-store UI uses `connections` + `connectionDetail` instead.
 */
exports.status = async (req, res) => {
    try {
        const { sub } = authUser(req);
        const connection = await connectionService.getConnectionForUser(sub);
        if (!connection) {
            return res.json({ success: true, connected: false, connection: null, locations: [], needsReconnect: false });
        }
        const live = await loadLiveShopData(connection);
        res.json({ success: true, connected: connection.status === 'active', connection, ...live });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /shopify/connections — every store the current user has connected (lightweight; no
 * Shopify API calls). Drives the multi-store switcher. Live per-store data (locations,
 * publications) is loaded separately via {@link connectionDetail}.
 */
exports.connections = async (req, res) => {
    try {
        const { sub } = authUser(req);
        const connections = await connectionService.listConnectionsForUser(sub);
        res.json({ success: true, connections });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /shopify/connection/:id/detail — one owned connection plus its live shop data (inventory
 * locations + sales channels + publishing/reconnect flags). The switcher loads this on demand
 * when a store is selected.
 */
exports.connectionDetail = async (req, res) => {
    try {
        const connection = await loadOwned(req);
        const live = await loadLiveShopData(connection);
        res.json({ success: true, connection, ...live });
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

        // NOTE: the automatic "initial push" on first sync-ready save is intentionally DISABLED.
        // Saving the config never triggers a sync — the partner explicitly clicks "Sync now"
        // (and the scheduled/PNV auto-triggers still run). To re-enable, restore the block that
        // fired `startStockSync(updated._id, { trigger: 'initial' })` when the connection became
        // sync-ready (has a source + shopifyLocationId) and had never synced (!lastSyncAt).

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
        // The panel shows a short window; the "view all" modal asks for more via ?limit=.
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const [runs, stateCounts, latest, deletedRows] = await Promise.all([
            syncJobs.listRecentRuns(connection._id, limit),
            productMap.getStateCounts(connection._id),
            syncJobs.getLatestRun(connection._id),
            productMap.getDeletedInStore(connection._id)
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
            unmatched: latest?.unmatched || [],
            // Handed-off products the merchant deleted in Shopify — grouped by parent product so
            // the UI can warn + offer a per-product "Recreate on next sync" action.
            deletedInStore: groupDeletedByParent(deletedRows)
        });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * POST /shopify/connection/:id/recreate — queue (or un-queue) deleted-in-store handoff products
 * for recreation on the NEXT sync. Owner-checked. Body: `{ parentCodes: string[], cancel?: bool }`.
 * `cancel: true` is the undo — it cancels a queued recreation but keeps the product tombstoned.
 * Only rows currently in the `deleted_in_store` state are touched; nothing is pushed now (the next
 * run recreates them). Responds with the refreshed deleted-in-store list so the UI updates in place.
 */
exports.recreate = async (req, res) => {
    try {
        const connection = await loadOwned(req);
        const parentCodes = Array.isArray(req.body?.parentCodes) ? req.body.parentCodes.filter(Boolean) : [];
        if (!parentCodes.length) {
            const error = new Error('No products selected to recreate');
            error.code = 'BAD_REQUEST';
            throw error;
        }
        const requested = req.body?.cancel !== true;
        const flagged = await productMap.requestRecreate(connection._id, parentCodes, requested);
        const deletedRows = await productMap.getDeletedInStore(connection._id);
        res.json({ success: true, flagged, deletedInStore: groupDeletedByParent(deletedRows) });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * DELETE /shopify/connection/:id — disconnect: uninstall the app from the merchant's Shopify
 * admin AND delete our record + product map. So a portal disconnect mirrors a Shopify uninstall.
 */
exports.disconnect = async (req, res) => {
    try {
        const connection = await loadOwned(req);
        // Best-effort self-uninstall so the app is removed in Shopify too, not just in the portal.
        // If the token can't be obtained/used (already uninstalled, refresh dead), we still drop
        // our record — the merchant's app card may linger but it has no working access either way.
        try {
            const token = await tokenService.getValidAccessToken(connection._id);
            await shopifyApi.uninstallApp(connection.shopDomain, token);
        } catch (err) {
            console.warn('[shopify] self-uninstall on disconnect failed (continuing):',
                err.code || err.response?.status || err.message);
        }
        await connectionService.deleteConnection(req.params.id);
        // Drop the now-orphaned product map (so a later reinstall re-matches cleanly) and the
        // sync-run history — a portal disconnect erases everything we hold for the store.
        await productMap.deleteForConnection(connection._id);
        await syncJobs.deleteForConnection(connection._id);
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
            case 'app/uninstalled': {
                // Merchant removed the app in Shopify → mark our connection(s) uninstalled (which
                // hides them from the portal) and drop their product maps so a reinstall re-matches.
                const ids = await connectionService.markUninstalledByShop(shopDomain);
                await Promise.all(ids.map((id) => productMap.deleteForConnection(id)));
                console.log(`[shopify] app uninstalled: ${shopDomain} (${ids.length} connection(s))`);
                break;
            }
            case 'shop/redact': {
                // Sent ~48h after uninstall. Erase everything still held for the shop: the
                // residual connection row (domain, owner, config), product maps and sync history.
                const ids = await connectionService.deleteByShopDomain(shopDomain);
                await Promise.all(ids.flatMap((id) => [
                    productMap.deleteForConnection(id),
                    syncJobs.deleteForConnection(id)
                ]));
                console.log(`[shopify] shop/redact: erased ${ids.length} connection(s) for ${shopDomain}`);
                break;
            }
            case 'customers/redact':
            case 'customers/data_request':
                // One-way push app — we never request customer scopes and hold no Shopify
                // customer data, so there is nothing to redact/report. Acknowledge per GDPR.
                console.log(`[shopify] GDPR webhook ${topic} for ${shopDomain} — no customer data held`);
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
