const express = require('express');
const router = express.Router();

const jwtCheck = require('../middleware/auth0');
const requireExportRole = require('../middleware/requireExportRole');
const requireTier = require('../middleware/requireTier');
// Shopify + Own Sources are in the ALPHA program (design: early-access tiers) — flip or drop here.
const requireAlpha = requireTier('alpha');
const externalController = require('../controllers/externalController');

// All Own Sources routes are JWT + export-role gated; ownership is checked per-feed in the
// controller (mirrors shopifyRoutes). Mounted at /api/export/external.

// Transient pre-save test (no feedId): validate an arbitrary feed URL before persisting it.
router.post('/test', jwtCheck, requireExportRole, requireAlpha, externalController.test);

router.get('/sources', jwtCheck, requireExportRole, requireAlpha, externalController.list);
router.post('/sources', jwtCheck, requireExportRole, requireAlpha, externalController.create);
router.get('/sources/:feedId', jwtCheck, requireExportRole, requireAlpha, externalController.get);
router.put('/sources/:feedId', jwtCheck, requireExportRole, requireAlpha, externalController.update);
router.delete('/sources/:feedId', jwtCheck, requireExportRole, requireAlpha, externalController.remove);
router.post('/sources/:feedId/test', jwtCheck, requireExportRole, requireAlpha, externalController.test);
router.post('/sources/:feedId/import', jwtCheck, requireExportRole, requireAlpha, externalController.importNow);
router.get('/sources/:feedId/activity', jwtCheck, requireExportRole, requireAlpha, externalController.activity);
router.get('/sources/:feedId/products', jwtCheck, requireExportRole, requireAlpha, externalController.products);

module.exports = router;
