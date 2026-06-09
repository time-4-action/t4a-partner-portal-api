const express = require('express');
const router = express.Router();
const webhookApiKey = require('../middleware/webhookApiKey');
const webhookController = require('../controllers/webhookController');

// All webhook routes require a valid x-api-key header
router.post('/sync/pnv', webhookApiKey, webhookController.triggerPnvSync);
router.post('/sync/ai-categorization', webhookApiKey, webhookController.triggerAiCategorization);
router.post('/sync/shopify', webhookApiKey, webhookController.triggerShopifyReconcile);
router.post('/categorize', webhookApiKey, webhookController.categorizeExternal);

module.exports = router;
