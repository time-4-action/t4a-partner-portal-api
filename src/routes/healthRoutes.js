const express = require('express');
const router = express.Router();
const healthController = require('../controllers/healthController');

// GET / - Provides detailed health status of the service
router.get('/', healthController.getHealth);

module.exports = router;
