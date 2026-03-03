const express = require('express');
const router = express.Router();
const rechargeController = require('../controllers/rechargeController');

router.get('/xml/all', rechargeController.getAllXml);

module.exports = router;
