const axios = require('axios');

/**
 * Thin Shopify client for the OAuth/connection layer.
 *
 * Scope here is deliberately small. The two operations that touch the Admin API itself —
 * shop lookup and webhook registration — now live in {@link module:shopifyGraphql.service}
 * (App-Store requirement 2.2.4: new public apps must use the GraphQL Admin API). What remains
 * here are the OAuth token endpoints (`exchangeCodeForToken`/`refreshAccessToken`, which are NOT
 * Admin API calls and have no GraphQL form) and the documented self-uninstall.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

/**
 * Exchanges an OAuth `code` for an **expiring offline** access token.
 *
 * `expiring: '1'` is mandatory as of Shopify's 2026-04-01 enforcement — legacy non-expiring
 * tokens are now rejected by the Admin API (REST *and* GraphQL) with a 403. The response
 * carries a short-lived access token (~60 min) plus a refresh token (~90 days) used to renew
 * it; see {@link refreshAccessToken} and {@link module:shopifyToken.service}.
 *
 * @param {string} shop - full myshopify domain
 * @param {string} code - authorization code from the callback
 * @returns {Promise<{ access_token: string, scope: string, expires_in: number,
 *   refresh_token: string, refresh_token_expires_in: number }>}
 */
async function exchangeCodeForToken(shop, code) {
    const { data } = await axios.post(
        `https://${shop}/admin/oauth/access_token`,
        {
            client_id: process.env.SHOPIFY_API_KEY,
            client_secret: process.env.SHOPIFY_API_SECRET,
            code,
            expiring: '1'
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return data;
}

/**
 * Renews an expiring offline access token using its refresh token. Obtaining a new token
 * retires the previous one (and its refresh token) immediately, so callers must persist the
 * returned values and never reuse the old refresh token.
 *
 * @param {string} shop - full myshopify domain
 * @param {string} refreshToken
 * @returns {Promise<{ access_token: string, scope: string, expires_in: number,
 *   refresh_token: string, refresh_token_expires_in: number }>}
 */
async function refreshAccessToken(shop, refreshToken) {
    const { data } = await axios.post(
        `https://${shop}/admin/oauth/access_token`,
        {
            client_id: process.env.SHOPIFY_API_KEY,
            client_secret: process.env.SHOPIFY_API_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return data;
}

/**
 * Uninstalls THIS app from the shop by revoking the current access token — Shopify's documented
 * "app uninstalls itself" call (`DELETE /admin/api/<ver>/api_permissions/current.json`). It
 * removes the app from the merchant's admin and triggers the `app/uninstalled` webhook. Used so
 * that disconnecting in the portal also removes the app in Shopify. An already-invalid token
 * 401s — the caller treats that as "already uninstalled" and proceeds.
 *
 * NOTE: this is the one remaining REST Admin call — there is no GraphQL mutation for an app to
 * uninstall itself, so it can't be migrated (requirement 2.2.4). It's app-lifecycle, not data
 * access, and only fires on an explicit portal disconnect.
 * @param {string} shop - full myshopify domain
 * @param {string} accessToken
 */
async function uninstallApp(shop, accessToken) {
    await axios.delete(
        `https://${shop}/admin/api/${API_VERSION}/api_permissions/current.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken }, timeout: 15000 }
    );
}

module.exports = {
    API_VERSION,
    exchangeCodeForToken,
    refreshAccessToken,
    uninstallApp
};
