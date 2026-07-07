const express = require('express');
const router = express.Router();

const jwtCheck = require('../middleware/auth0');
const requireExportRole = require('../middleware/requireExportRole');
const requireTier = require('../middleware/requireTier');
// Shopify is now generally available — the shared public-app OAuth + all connection management are
// gated only by the `export` role. The legacy "bring your own custom app" (Deprecated) connect
// entry points stay behind the `beta` tier while that flow is wound down.
const requireBeta = requireTier('beta');
const shopifyController = require('../controllers/shopifyController');

// ─── OAuth ────────────────────────────────────────────────────────────────────
// `entry` is the app's **App URL** — Shopify loads it (NO JWT) when a merchant opens the app
// from their admin. Secured by the OAuth HMAC over the query; redirects into the portal.
router.get('/entry', shopifyController.entry);

// `connect` is started by a logged-in portal user (JWT + export role).
router.get('/connect', jwtCheck, requireExportRole, shopifyController.connect);

// `connect-custom` is the "Shopify Deprecated" (Route B) path — a logged-in portal user pastes a
// custom-app Admin API token instead of running OAuth. Kept on the beta tier while it's deprecated.
router.post('/connect-custom', jwtCheck, requireExportRole, requireBeta, shopifyController.connectCustom);

// `connect-custom-oauth` is the "Shopify Deprecated" bring-your-own-OAuth-app path — a logged-in
// portal user pastes their app's client_id + client_secret; we return their app's authorize URL.
router.post('/connect-custom-oauth', jwtCheck, requireExportRole, requireBeta, shopifyController.connectCustomOAuth);

// `callback` is hit by the browser redirect from Shopify — NO JWT. It is secured by
// the OAuth HMAC + the signed `state` nonce instead (see crypto.service).
router.get('/callback', shopifyController.callback);

// `callback-custom` is the redirect target for a bring-your-own-OAuth-app install — NO JWT.
// Secured by the signed `state` (identifies the app) + that app's own HMAC (see shopifyOAuth).
router.get('/callback-custom', shopifyController.callbackCustom);

// ─── Post-install claim / decline (Shopify-initiated pending connections) ───────
// `claim` binds a pending install to the signed-in partner. `decline` is the clean break for a
// merchant who doesn't want to connect — both are authorized by the one-time claim token.
router.post('/connection/claim', jwtCheck, requireExportRole, shopifyController.claim);
router.post('/connection/decline', jwtCheck, requireExportRole, shopifyController.decline);

// ─── Connection management (JWT + export role, owner-checked in controller) ─────
router.get('/status', jwtCheck, requireExportRole, shopifyController.status);
router.get('/connections', jwtCheck, requireExportRole, shopifyController.connections);
router.get('/pricelists', jwtCheck, requireExportRole, shopifyController.pricelists);
router.get('/connection/:id/detail', jwtCheck, requireExportRole, shopifyController.connectionDetail);
// Reconnect a bring-your-own-app (custom_oauth) store using its stored app credentials.
router.get('/connection/:id/reconnect-custom', jwtCheck, requireExportRole, shopifyController.reconnectCustomOAuth);
router.put('/connection/:id/config', jwtCheck, requireExportRole, shopifyController.updateConfig);
router.post('/connection/:id/sync', jwtCheck, requireExportRole, shopifyController.sync);
router.post('/connection/:id/recreate', jwtCheck, requireExportRole, shopifyController.recreate);
router.get('/connection/:id/activity', jwtCheck, requireExportRole, shopifyController.activity);
router.delete('/connection/:id', jwtCheck, requireExportRole, shopifyController.disconnect);

// ─── Webhooks ───────────────────────────────────────────────────────────────
// HMAC-verified against the raw body (captured in app.js). No JWT — Shopify calls this.
router.post('/webhooks', shopifyController.webhook);

module.exports = router;
