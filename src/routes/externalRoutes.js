const express = require('express');
const router = express.Router();

const jwtCheck = require('../middleware/auth0');
const requireExportRole = require('../middleware/requireExportRole');
const externalController = require('../controllers/externalController');

// All Own Sources routes are JWT + export-role gated; ownership is checked per-feed in the
// controller (mirrors shopifyRoutes). Mounted at /api/export/external.

// Transient pre-save test (no feedId): validate an arbitrary feed URL before persisting it.
router.post('/test', jwtCheck, requireExportRole, externalController.test);

router.get('/sources', jwtCheck, requireExportRole, externalController.list);
router.post('/sources', jwtCheck, requireExportRole, externalController.create);
router.get('/sources/:feedId', jwtCheck, requireExportRole, externalController.get);
router.put('/sources/:feedId', jwtCheck, requireExportRole, externalController.update);
router.delete('/sources/:feedId', jwtCheck, requireExportRole, externalController.remove);
router.post('/sources/:feedId/test', jwtCheck, requireExportRole, externalController.test);
router.post('/sources/:feedId/import', jwtCheck, requireExportRole, externalController.importNow);
router.get('/sources/:feedId/activity', jwtCheck, requireExportRole, externalController.activity);
router.get('/sources/:feedId/products', jwtCheck, requireExportRole, externalController.products);

module.exports = router;
