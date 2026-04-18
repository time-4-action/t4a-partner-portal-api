const express = require('express');
const app = express();
const path = require('path');
const logger = require('./middleware/logger');
const apiAnalyticsLogger = require('./middleware/analytics');
const exportRoutes = require('./routes/export');

app.use(express.json());
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
