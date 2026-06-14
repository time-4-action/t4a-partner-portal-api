const express = require('express');
const router = express.Router();

const jwtCheck = require('../middleware/auth0');
const requireExportRole = require('../middleware/requireExportRole');
const requireTier = require('../middleware/requireTier');
// Shopify + Own Sources are in the ALPHA program (design: early-access tiers) — flip or drop here.
const requireAlpha = requireTier('alpha');
const shopifyController = require('../controllers/shopifyController');

// ─── OAuth ────────────────────────────────────────────────────────────────────
// `entry` is the app's **App URL** — Shopify loads it (NO JWT) when a merchant opens the app
// from their admin. Secured by the OAuth HMAC over the query; redirects into the portal.
router.get('/entry', shopifyController.entry);

// `connect` is started by a logged-in portal user (JWT + export role).
router.get('/connect', jwtCheck, requireExportRole, requireAlpha, shopifyController.connect);

// `callback` is hit by the browser redirect from Shopify — NO JWT. It is secured by
// the OAuth HMAC + the signed `state` nonce instead (see crypto.service).
router.get('/callback', shopifyController.callback);

// ─── Post-install claim / decline (Shopify-initiated pending connections) ───────
// `claim` binds a pending install to the signed-in approved partner (alpha-gated). `decline` is
// the clean break for a non-approved install — NOT alpha-gated (a signed-in user without the tier
// must be able to tidy up their own install); the one-time claim token authorizes both.
router.post('/connection/claim', jwtCheck, requireExportRole, requireAlpha, shopifyController.claim);
router.post('/connection/decline', jwtCheck, requireExportRole, shopifyController.decline);

// ─── Connection management (JWT + export role, owner-checked in controller) ─────
router.get('/status', jwtCheck, requireExportRole, requireAlpha, shopifyController.status);
router.get('/connections', jwtCheck, requireExportRole, requireAlpha, shopifyController.connections);
router.get('/pricelists', jwtCheck, requireExportRole, requireAlpha, shopifyController.pricelists);
router.get('/connection/:id/detail', jwtCheck, requireExportRole, requireAlpha, shopifyController.connectionDetail);
router.put('/connection/:id/config', jwtCheck, requireExportRole, requireAlpha, shopifyController.updateConfig);
router.post('/connection/:id/sync', jwtCheck, requireExportRole, requireAlpha, shopifyController.sync);
router.post('/connection/:id/recreate', jwtCheck, requireExportRole, requireAlpha, shopifyController.recreate);
router.get('/connection/:id/activity', jwtCheck, requireExportRole, requireAlpha, shopifyController.activity);
router.delete('/connection/:id', jwtCheck, requireExportRole, requireAlpha, shopifyController.disconnect);

// ─── Webhooks ───────────────────────────────────────────────────────────────
// HMAC-verified against the raw body (captured in app.js). No JWT — Shopify calls this.
router.post('/webhooks', shopifyController.webhook);

module.exports = router;
