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
 * Exchanges an OAuth `code` for a permanent access token.
 * @param {string} shop - full myshopify domain
 * @param {string} code - authorization code from the callback
 * @returns {Promise<{ access_token: string, scope: string }>}
 */
async function exchangeCodeForToken(shop, code) {
    const { data } = await axios.post(
        `https://${shop}/admin/oauth/access_token`,
        {
            client_id: process.env.SHOPIFY_API_KEY,
            client_secret: process.env.SHOPIFY_API_SECRET,
            code
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
 * Lists the shop's inventory locations (for the connection's location picker).
 * @returns {Promise<Array<{ id: string, name: string, active: boolean }>>}
 */
async function listLocations(shop, accessToken) {
    const { data } = await adminClient(shop, accessToken).get('/locations.json');
    return (data.locations || []).map((l) => ({
        id: `gid://shopify/Location/${l.id}`,
        legacyId: String(l.id),
        name: l.name,
        active: l.active !== false
    }));
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

module.exports = {
    API_VERSION,
    REQUIRED_WEBHOOK_TOPICS,
    exchangeCodeForToken,
    registerWebhooks,
    listLocations,
    getShopInfo
};
