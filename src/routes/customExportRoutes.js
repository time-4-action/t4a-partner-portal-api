const express = require('express');
const router = express.Router();
const customExportController = require('../controllers/customExportController');

/**
 * @route   POST /custom-export
 * @desc    Create a new export configuration
 * @access  Public (or Protected based on your auth setup)
 */
router.post('/', customExportController.createConfig);

/**
 * @route   GET /custom-export
 * @desc    Get all export configurations
 * @query   active - Filter by active status (default: true)
 * @query   preset - Filter by preset type (shopify|simple|detailed|inventory)
 * @query   sort - Sort field (prefix with - for descending, default: -createdAt)
 * @query   limit - Max results (default: 50)
 * @access  Public (or Protected based on your auth setup)
 */
router.get('/', customExportController.getAllConfigs);

/**
 * @route   GET /custom-export/:id
 * @desc    Get a single export configuration by ID
 * @access  Public (or Protected based on your auth setup)
 */
router.get('/:id', customExportController.getConfigById);

/**
 * @route   PUT /custom-export/:id
 * @desc    Update an export configuration
 * @access  Public (or Protected based on your auth setup)
 */
router.put('/:id', customExportController.updateConfig);

/**
 * @route   DELETE /custom-export/:id
 * @desc    Delete an export configuration (soft delete by default)
 * @query   hard - If true, permanently delete the configuration
 * @access  Public (or Protected based on your auth setup)
 */
router.delete('/:id', customExportController.deleteConfig);

/**
 * @route   GET /custom-export/:id/csv
 * @desc    Generate and download CSV export based on configuration
 * @query   download - If true, sets Content-Disposition for file download
 * @access  Public (or Protected based on your auth setup)
 */
router.get('/:id/csv', customExportController.generateCsv);

/**
 * @route   GET /custom-export/:id/json
 * @desc    Generate JSON export based on configuration
 * @access  Public (or Protected based on your auth setup)
 */
router.get('/:id/json', customExportController.generateJson);

module.exports = router;
