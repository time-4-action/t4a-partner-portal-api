const oauthService = require('../services/shopify/shopifyOAuth.service');
const connectionService = require('../services/shopify/shopifyConnection.service');
const shopifyApi = require('../services/shopify/shopifyApi.service');
const { decryptToken, verifyWebhookHmac } = require('../services/shopify/crypto.service');

/**
 * Controller for the Shopify connection lifecycle (design §10).
 * OAuth: connect → callback. Management: status, config, disconnect. Plus webhooks.
 */

const ERROR_STATUS_MAP = {
    VALIDATION_ERROR: 400,
    INVALID_ID: 400,
    INVALID_HMAC: 401,
    INVALID_STATE: 401,
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    SERVER_ERROR: 500
};

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
            return res.json({ success: true, connected: false, connection: null, locations: [] });
        }

        let locations = [];
        if (connection.status === 'active') {
            try {
                const raw = await connectionService.getConnectionWithToken(connection._id);
                if (raw?.accessTokenEnc) {
                    locations = await shopifyApi.listLocations(connection.shopDomain, decryptToken(raw.accessTokenEnc));
                }
            } catch (err) {
                console.error('[shopify] listLocations failed:', err.message);
            }
        }

        res.json({ success: true, connected: connection.status === 'active', connection, locations });
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
        res.json({ success: true, data: updated });
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
        await loadOwned(req);
        await connectionService.deleteConnection(req.params.id);
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
