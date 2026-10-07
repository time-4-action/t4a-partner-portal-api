const express = require('express');
const app = express();
const path = require('path');

// Liveness probe for the CI deploy and the public verify step. Registered before the request
// logger and analytics so probes are not recorded, and free of MongoDB/PNV/Metakocka (unlike
// /api/export/health) so an outage of a dependency never makes a deploy roll back.
app.get('/api/export/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
});
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
const internalAdminToken = require('./middleware/internalAdminToken');
const adminPartnersRoutes = require('./routes/adminPartnersRoutes');
const adminSystemRoutes = require('./routes/adminSystemRoutes');
app.use('/api/export/health', healthRoutes);
app.use('/api/product', productRoutes);
app.use('/api/export', exportRoutes);

// Internal admin surface consumed by the t4a-admin "Partners" section. Bearer-token
// gated (PARTNER_ADMIN_TOKEN); not part of the partner-facing /api/export tree.
app.use('/api/admin/partners', internalAdminToken, adminPartnersRoutes);

// Scheduler status + manual triggers for the t4a-admin "Catalogue Sync" page. Same bearer gate.
app.use('/api/admin/system', internalAdminToken, adminSystemRoutes);

// The Sources API (docs/sources-api.md): a versioned machine contract for another product
// (Recharge Hub) to configure and run ONE connected store's sources, gated by a per-connection
// API key a partner generates on the Shopify integration page. Versioned in the path so it can
// move on without breaking a client.
const sourcesApiRoutes = require('./routes/sourcesApiRoutes');
app.use('/api/v1', sourcesApiRoutes);

module.exports = { app };
