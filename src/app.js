const express = require('express');
const app = express();
const path = require('path');
const logger = require('./middleware/logger');
const apiAnalyticsLogger = require('./middleware/analytics');
const exportRoutes = require('./routes/export');

// Capture the raw request body so Shopify webhook HMACs can be verified against the exact
// bytes sent (a re-serialized JSON body would not match the signature).
app.use(express.json({
    verify: (req, _res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(logger);
app.use(apiAnalyticsLogger);
app.set('trust proxy', true);

app.use(express.static(path.join(__dirname, '..', 'public')));

const healthRoutes = require('./routes/healthRoutes');
const productRoutes = require('./routes/productRoutes');
app.use('/api/export/health', healthRoutes);
app.use('/api/product', productRoutes);
app.use('/api/export', exportRoutes);

module.exports = { app };
