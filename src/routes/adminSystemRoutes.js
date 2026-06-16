const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminSystemController');

// Internal admin surface for the t4a-admin "Catalogue Sync" page. Mounted behind
// internalAdminToken (shared bearer) in app.js — see /api/admin/system.

router.get('/sync', controller.syncStatus);
router.post('/sync/pnv/run', controller.runPnv);
router.post('/sync/own-sources/:feedId/run', controller.runOwnSource);

module.exports = router;
