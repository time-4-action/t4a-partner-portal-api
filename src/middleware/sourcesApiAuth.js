const { verifyConnectionApiKey } = require('../services/shopify/connectionApiKey.service');

/**
 * Bearer auth for the Sources API (`/api/v1`, `docs/sources-api.md`).
 *
 *   Authorization: Bearer <connection api key>
 *   X-Shop-Domain: <shop>.myshopify.com
 *
 * The key names one connection; the shop header must be that connection's store. The two are
 * checked separately on purpose — 401 is "not a key we know", 403 is "a real key, but not for the
 * store you say you are" — because the client shows them differently (paste a new key vs. you
 * pasted another store's key). A connection that is no longer active (uninstalled, awaiting
 * re-auth) answers 409 so the client can say "reconnect the store in the portal" rather than
 * "wrong key".
 *
 * Replies use the contract's error shape: `{ error: { code, message } }`.
 */
function refuse(res, status, code, message) {
    return res.status(status).json({ error: { code, message } });
}

async function sourcesApiAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const rawKey = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!rawKey) return refuse(res, 401, 'missing_key', 'Send the API key as a bearer token.');

    let verified;
    try {
        verified = await verifyConnectionApiKey(rawKey);
    } catch (err) {
        console.error('[sources-api] key verification failed:', err.message);
        return refuse(res, 500, 'auth_error', 'The key could not be checked.');
    }
    if (!verified) return refuse(res, 401, 'invalid_key', 'The API key is not valid or has been revoked.');

    const { connection, keyRecord } = verified;
    const shop = String(req.headers['x-shop-domain'] || '').trim().toLowerCase();
    if (!shop) return refuse(res, 403, 'shop_required', 'Send the store as X-Shop-Domain.');
    if (shop !== String(connection.shopDomain || '').toLowerCase()) {
        return refuse(res, 403, 'shop_mismatch', 'This API key was issued for a different store.');
    }
    if (connection.status !== 'active') {
        return refuse(res, 409, 'store_not_connected', 'The store is not connected in the portal. Reconnect it there, then try again.');
    }

    req.sourcesApi = { connection, keyRecord };
    return next();
}

module.exports = sourcesApiAuth;
