const connectionService = require('./shopifyConnection.service');
const shopifyApi = require('./shopifyApi.service');
const { decryptToken } = require('./crypto.service');

/**
 * Access-token validity for the Shopify data plane (expiring offline tokens, 2026-04).
 *
 * Shopify access tokens now expire after ~60 minutes and are renewed with a refresh token
 * (~90 days). {@link getValidAccessToken} returns a token guaranteed fresh for the next call:
 * it refreshes a few minutes ahead of expiry, persists the rotated pair, and serializes
 * refreshes per connection — obtaining a new token *retires the previous one*, so two
 * concurrent refreshes would invalidate each other.
 *
 * Connections still holding a legacy non-expiring token (no refresh token) can't be renewed —
 * Shopify rejects those outright — so this throws `REAUTH_REQUIRED`, which the UI turns into a
 * "reconnect your store" prompt.
 */

/** Refresh this many ms before the token's stated expiry, to avoid racing the clock. */
const REFRESH_SKEW_MS = 2 * 60 * 1000;

/** In-flight refresh per connection id, so concurrent callers share one refresh. */
const inflight = new Map();

function reauth(message) {
    return Object.assign(new Error(message), { code: 'REAUTH_REQUIRED' });
}

async function resolveToken(connectionId) {
    const conn = await connectionService.getConnectionWithToken(connectionId);
    if (!conn) throw Object.assign(new Error('Connection not found'), { code: 'NOT_FOUND' });
    if (!conn.accessTokenEnc) throw Object.assign(new Error('Connection is not active'), { code: 'NOT_ACTIVE' });

    const expiresAt = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt).getTime() : null;

    // Legacy non-expiring token (pre-expiring-offline migration) — unrenewable and now
    // rejected by the Admin API. The user must reconnect to mint a refreshable token.
    if (!conn.refreshTokenEnc || !expiresAt) {
        throw reauth('Your Shopify connection uses an outdated token. Reconnect your store to continue.');
    }

    // Still comfortably valid — use it as-is.
    if (expiresAt - Date.now() > REFRESH_SKEW_MS) {
        return decryptToken(conn.accessTokenEnc);
    }

    // Near/past expiry — refresh, persist, and return the new access token.
    let resp;
    try {
        resp = await shopifyApi.refreshAccessToken(conn.shopDomain, decryptToken(conn.refreshTokenEnc));
    } catch (err) {
        // Refresh token expired/invalid → mark the connection and ask the user to reconnect.
        await connectionService.setStatus(conn._id, 'error');
        const detail = err.response?.status ? ` (${err.response.status})` : '';
        throw reauth(`Could not refresh Shopify access${detail}. Reconnect your store to continue.`);
    }
    await connectionService.updateTokens(conn._id, {
        accessToken: resp.access_token,
        refreshToken: resp.refresh_token,
        expiresIn: resp.expires_in,
        refreshTokenExpiresIn: resp.refresh_token_expires_in
    });
    return resp.access_token;
}

/**
 * Returns a currently-valid Admin API access token for a connection, refreshing it first if
 * it's within the skew window. Concurrent calls for the same connection share one refresh.
 *
 * @param {ObjectId|string} connectionId
 * @returns {Promise<string>} a fresh access token
 * @throws {Error} code `REAUTH_REQUIRED` (reconnect needed), `NOT_ACTIVE`, or `NOT_FOUND`
 */
function getValidAccessToken(connectionId) {
    const key = String(connectionId);
    const existing = inflight.get(key);
    if (existing) return existing;

    const run = resolveToken(connectionId).finally(() => {
        if (inflight.get(key) === run) inflight.delete(key);
    });
    inflight.set(key, run);
    return run;
}

module.exports = { getValidAccessToken };
