const express = require('express');
const router = express.Router();

const jwtCheck = require('../middleware/auth0');
const requireExportRole = require('../middleware/requireExportRole');
const shopifyController = require('../controllers/shopifyController');

// ─── OAuth ────────────────────────────────────────────────────────────────────
// `connect` is started by a logged-in portal user (JWT + export role).
router.get('/connect', jwtCheck, requireExportRole, shopifyController.connect);

// `callback` is hit by the browser redirect from Shopify — NO JWT. It is secured by
// the OAuth HMAC + the signed `state` nonce instead (see crypto.service).
router.get('/callback', shopifyController.callback);

// ─── Connection management (JWT + export role, owner-checked in controller) ─────
router.get('/status', jwtCheck, requireExportRole, shopifyController.status);
router.get('/pricelists', jwtCheck, requireExportRole, shopifyController.pricelists);
router.put('/connection/:id/config', jwtCheck, requireExportRole, shopifyController.updateConfig);
router.post('/connection/:id/sync', jwtCheck, requireExportRole, shopifyController.sync);
router.get('/connection/:id/activity', jwtCheck, requireExportRole, shopifyController.activity);
router.delete('/connection/:id', jwtCheck, requireExportRole, shopifyController.disconnect);

// ─── Webhooks ───────────────────────────────────────────────────────────────
// HMAC-verified against the raw body (captured in app.js). No JWT — Shopify calls this.
router.post('/webhooks', shopifyController.webhook);

module.exports = router;
