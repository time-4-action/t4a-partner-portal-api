const { signState, verifyState, verifyOAuthHmac } = require('./crypto.service');
const shopifyApi = require('./shopifyApi.service');
const shopifyGraphql = require('./shopifyGraphql.service');
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
 * Builds the Shopify OAuth authorize URL.
 *
 * Two callers:
 *   • Portal-initiated (`/shopify/connect`, JWT) — passes `sub`/`email`; the install binds to
 *     that portal user directly in {@link handleCallback}.
 *   • Shopify-initiated (the App URL `/shopify/entry`, NO portal session) — passes no `sub`. This
 *     is the App-Store "immediately authenticate after install" path: a merchant opening the app
 *     on a fresh store is sent straight to the OAuth grant. The resulting callback is "anonymous"
 *     (see {@link handleCallback}) and routes the merchant into the portal to finish connecting
 *     (sign in → the UI auto-resumes OAuth, now authenticated → the connection binds to them).
 *
 * @param {{ shopInput: string, sub?: string, email?: string|null }} args
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

    // `sub` is omitted for a Shopify-initiated install — the signed state still binds the flow to
    // this shop + a nonce (anti-CSRF); the portal user is bound later when the UI resumes OAuth.
    const state = signState({ sub: sub || null, email: email || null, shop });
    const params = new URLSearchParams({
        client_id: process.env.SHOPIFY_API_KEY,
        scope: connectionService.DEFAULT_SCOPES.join(','),
        redirect_uri: `${process.env.SHOPIFY_API_BASE_URL}/shopify/callback`,
        state
    });
    return { url: `https://${shop}/admin/oauth/authorize?${params.toString()}`, shop };
}

/**
 * Handles the OAuth callback. Verifies hmac + state, then:
 *   • Anonymous install (no portal user in state — the Shopify-initiated App-URL path): returns
 *     `{ anonymous: true, shop }` WITHOUT exchanging the code. The controller routes the merchant
 *     into the portal, where the UI resumes OAuth as the signed-in user and the real connection is
 *     persisted. (Shopify silently re-grants the already-approved app, so the merchant isn't
 *     prompted again.) This keeps tokens bound to a known portal user — we never persist an
 *     ownerless connection.
 *   • Portal-initiated install (state carries the user's `sub`): exchanges the code, persists the
 *     connection, and registers the API webhooks.
 * @param {Object} query - parsed callback query (`code`, `shop`, `state`, `hmac`, ...)
 * @returns {Promise<{ anonymous: true, shop: string } | { connection: Object, webhooks: Object }>}
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

    // State proves the caller started the flow and binds it to this shop (anti-CSRF).
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

    // Shopify-initiated install: no portal user yet. Don't exchange/persist — hand off to the
    // portal, which re-runs OAuth as the signed-in user to create the owned connection.
    if (!payload.sub) {
        return { anonymous: true, shop: normalized };
    }

    const tokenResp = await shopifyApi.exchangeCodeForToken(normalized, code);
    const accessToken = tokenResp.access_token;
    const grantedScopes = (tokenResp.scope || '').split(',').map((s) => s.trim()).filter(Boolean);

    // Confirm the token works and capture shop metadata; non-fatal if it fails.
    let shopInfo = null;
    try {
        shopInfo = await shopifyGraphql.getShopInfo(normalized, accessToken);
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
        webhooks = await shopifyGraphql.registerWebhooks(normalized, accessToken);
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
