const express = require('express');
const router = express.Router();
const exportsController = require('../controllers/exportsController');

// GET /api/products - Retrieves all products
router.get('/', exportsController.getAllExports);
router.post('/', exportsController.createExport);
router.get('/:id/ai-status', exportsController.getAiStatus);
router.get('/:id', exportsController.getExportById);
router.put('/:id', exportsController.updateExport);
router.delete('/:id', exportsController.deleteExport);

module.exports = router;