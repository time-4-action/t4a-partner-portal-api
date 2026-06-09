const axios = require('axios');

/**
 * Thin Shopify Admin API client used by the OAuth/connection layer.
 *
 * Scope here is deliberately small — token exchange, webhook registration,
 * location listing, shop lookup. The full product/inventory push lives in the
 * (not-yet-built) sync engine; this module only covers what the connection
 * lifecycle needs.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-04';

/** Mandatory webhook topics registered on every install (uninstall + GDPR). */
const REQUIRED_WEBHOOK_TOPICS = [
    'app/uninstalled',
    'shop/redact',
    'customers/redact',
    'customers/data_request'
];

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
 * Returns an axios instance pre-authorized for a shop's Admin REST API.
 */
function adminClient(shop, accessToken) {
    return axios.create({
        baseURL: `https://${shop}/admin/api/${API_VERSION}`,
        headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
}

/**
 * Registers the mandatory webhooks (app/uninstalled + GDPR topics).
 * Idempotent on Shopify's side — re-registering an existing topic/address is a no-op-ish 422
 * that we swallow per-topic so one failure never blocks the others.
 * @returns {Promise<{ registered: string[], failed: Array<{topic:string,error:string}> }>}
 */
async function registerWebhooks(shop, accessToken) {
    const address = `${process.env.SHOPIFY_API_BASE_URL}/shopify/webhooks`;
    const client = adminClient(shop, accessToken);
    const registered = [];
    const failed = [];

    for (const topic of REQUIRED_WEBHOOK_TOPICS) {
        try {
            await client.post('/webhooks.json', { webhook: { topic, address, format: 'json' } });
            registered.push(topic);
        } catch (err) {
            // 422 "address already taken"/"already registered" is benign — treat as registered.
            const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            if (err.response?.status === 422 && /taken|already/i.test(body)) {
                registered.push(topic);
            } else {
                failed.push({ topic, error: body });
            }
        }
    }
    return { registered, failed };
}

/**
 * Fetches basic shop info (name, primary location, currency) — used to confirm
 * the token works right after install.
 * @returns {Promise<Object>}
 */
async function getShopInfo(shop, accessToken) {
    const { data } = await adminClient(shop, accessToken).get('/shop.json');
    return data.shop;
}

/**
 * Uninstalls THIS app from the shop by revoking the current access token — Shopify's documented
 * "app uninstalls itself" call (`DELETE /admin/api/<ver>/api_permissions/current.json`). It
 * removes the app from the merchant's admin and triggers the `app/uninstalled` webhook. Used so
 * that disconnecting in the portal also removes the app in Shopify. An already-invalid token
 * 401s — the caller treats that as "already uninstalled" and proceeds.
 * @param {string} shop - full myshopify domain
 * @param {string} accessToken
 */
async function uninstallApp(shop, accessToken) {
    await adminClient(shop, accessToken).delete('/api_permissions/current.json');
}

module.exports = {
    API_VERSION,
    REQUIRED_WEBHOOK_TOPICS,
    exchangeCodeForToken,
    refreshAccessToken,
    registerWebhooks,
    getShopInfo,
    uninstallApp
};
