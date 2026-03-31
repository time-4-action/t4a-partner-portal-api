const express = require('express');
const router = express.Router();

const jwtCheck = require('../../middleware/auth0');
const exampleRoutes = require('../exampleRoutes');
const productRoutes = require('../productRoutes');
const exportsRoutes = require('../exportsRoutes');
const categoriesRoutes = require('../categoriesRoutes');
const customExportRoutes = require('../customExportRoutes');
const rechargeRoutes = require('../rechargeRoutes');
const webhookRoutes = require('../webhookRoutes');

// Secure all routes with the JWT check middleware
// router.use(jwtCheck);

router.use('/example', exampleRoutes);
router.use('/product', productRoutes);
router.use('/exports', exportsRoutes);
router.use('/categories', categoriesRoutes);
router.use('/custom-export', customExportRoutes);
router.use('/recharge', rechargeRoutes);
router.use('/webhooks', webhookRoutes);

// Custom error handler for JWT authentication errors
router.use((err, req, res, next) => {
  if (err.name === 'UnauthorizedError' || err.status === 401) {
    return res.status(401).json({ message: err.message || 'Unauthorized' });
  }
  // Pass other errors to the default error handler
  return next(err);
});

module.exports = router;
