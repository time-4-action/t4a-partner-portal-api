const { signState, verifyState, verifyOAuthHmac } = require('./crypto.service');
const shopifyApi = require('./shopifyApi.service');
const connectionService = require('./shopifyConnection.service');

/**
 * OAuth orchestration for the Shopify connection lifecycle (design §5).
 *
 * Flow:
 *   buildInstallUrl()  — portal user starts OAuth; we hand back the Shopify authorize URL
 *                        with a signed `state` bound to their Auth0 sub.
 *   handleCallback()   — Shopify redirects the browser back; we verify hmac + state,
 *                        exchange the code, persist the (encrypted) token, register webhooks.
 */

/**
 * Normalizes a shop input to a full `*.myshopify.com` domain.
 * Accepts a bare subdomain (`acme`) or a full domain (`acme.myshopify.com`).
 * @param {string} input
 * @returns {string|null} normalized domain, or null if invalid
 */
function normalizeShopDomain(input) {
    if (!input) return null;
    let shop = String(input).trim().toLowerCase();
    shop = shop.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!shop.includes('.')) shop = `${shop}.myshopify.com`;
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

/**
 * Builds the Shopify OAuth authorize URL for a connecting portal user.
 * @param {{ shopInput: string, sub: string, email?: string|null }} args
 * @returns {{ url: string, shop: string }}
 */
function buildInstallUrl({ shopInput, sub, email }) {
    const shop = normalizeShopDomain(shopInput);
    if (!shop) {
        const error = new Error('Invalid shop domain');
        error.code = 'VALIDATION_ERROR';
        throw error;
    }
    if (!process.env.SHOPIFY_API_KEY) throw new Error('SHOPIFY_API_KEY must be set.');

    const state = signState({ sub, email, shop });
    const params = new URLSearchParams({
        client_id: process.env.SHOPIFY_API_KEY,
        scope: connectionService.DEFAULT_SCOPES.join(','),
        redirect_uri: `${process.env.SHOPIFY_API_BASE_URL}/shopify/callback`,
        state
    });
    return { url: `https://${shop}/admin/oauth/authorize?${params.toString()}`, shop };
}

/**
 * Handles the OAuth callback. Verifies hmac + state, exchanges the code for a token,
 * persists the connection, and registers mandatory webhooks.
 * @param {Object} query - parsed callback query (`code`, `shop`, `state`, `hmac`, ...)
 * @returns {Promise<{ connection: Object, webhooks: Object }>}
 */
async function handleCallback(query) {
    const { shop, code, state } = query;

    if (!verifyOAuthHmac(query)) {
        const error = new Error('HMAC validation failed');
        error.code = 'INVALID_HMAC';
        throw error;
    }

    const normalized = normalizeShopDomain(shop);
    if (!normalized) {
        const error = new Error('Invalid shop domain');
        error.code = 'VALIDATION_ERROR';
        throw error;
    }

    // State proves the caller started the flow and binds it to a portal user (anti-CSRF).
    let payload;
    try {
        payload = verifyState(state);
    } catch (err) {
        const error = new Error(`Invalid state: ${err.message}`);
        error.code = 'INVALID_STATE';
        throw error;
    }
    if (payload.shop !== normalized) {
        const error = new Error('State/shop mismatch');
        error.code = 'INVALID_STATE';
        throw error;
    }

    const tokenResp = await shopifyApi.exchangeCodeForToken(normalized, code);
    const accessToken = tokenResp.access_token;
    const grantedScopes = (tokenResp.scope || '').split(',').map((s) => s.trim()).filter(Boolean);

    // Confirm the token works and capture shop metadata; non-fatal if it fails.
    let shopInfo = null;
    try {
        shopInfo = await shopifyApi.getShopInfo(normalized, accessToken);
    } catch (err) {
        console.error('[shopify] getShopInfo failed after install:', err.message);
    }

    const connection = await connectionService.upsertConnection({
        ownerSub: payload.sub,
        ownerEmail: payload.email,
        shopDomain: normalized,
        accessToken,
        refreshToken: tokenResp.refresh_token,
        expiresIn: tokenResp.expires_in,
        refreshTokenExpiresIn: tokenResp.refresh_token_expires_in,
        scopes: grantedScopes,
        shopInfo
    });

    let webhooks = { registered: [], failed: [] };
    try {
        webhooks = await shopifyApi.registerWebhooks(normalized, accessToken);
    } catch (err) {
        console.error('[shopify] webhook registration failed:', err.message);
    }

    return { connection, webhooks };
}

module.exports = {
    normalizeShopDomain,
    buildInstallUrl,
    handleCallback
};
