const dotenv = require('dotenv');
const path = require('path');

// Determine the base path for .env files. Use DATA_PATH if defined, otherwise use the project root.
const envPath = process.env.DATA_PATH || process.cwd();

console.log(`Loading environment files from: ${envPath}`);

dotenv.config({ path: path.join(envPath, '.env') });

if (process.env.NODE_ENV === 'development') {
  dotenv.config({ path: path.resolve(envPath, '.env.development'), override: true });
}
console.log(`App Started (${process.env.NODE_ENV})`);

const { app } = require('./src/app');
const { connectToDb } = require('./src/services/db/mongo.service');
const { ensureIndexesAndMigrate } = require('./src/services/customExport.service');
const { ensureIndexes: ensureShopifyIndexes } = require('./src/services/shopify/shopifyConnection.service');
const { ensureIndexes: ensureExternalIndexes } = require('./src/services/external/ownSource.service');
const externalScheduler = require('./src/services/external/externalScheduler.service');
const pnvScheduler = require('./src/services/pnv/pnvScheduler.service');
const shopifyPendingCleanup = require('./src/services/shopify/pendingCleanup.service');

const PORT = process.env.PORT || 3000;

const startServer = async () => {

  await connectToDb();
  await ensureIndexesAndMigrate();
  await ensureShopifyIndexes();
  await ensureExternalIndexes();

  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });

  // Portal-driven Own Source feed scheduler (design §8.2) — self-serve, no n8n.
  externalScheduler.start();

  // In-app PNV catalogue scheduler (PRODUCTS_DOWNLOAD_SCHEDULE cron) — replaces the n8n cron;
  // the /webhooks/sync/* endpoints stay available as a manual/back-fill escape hatch.
  await pnvScheduler.start();

  // Sweep abandoned PENDING Shopify installs (merchant approved OAuth but never claimed) so we
  // never hold an unbound store's token longer than the TTL.
  shopifyPendingCleanup.start();
};

const gracefulShutdown = async () => {
  console.log('Received shutdown signal, closing server gracefully...');
  pnvScheduler.stop();
  externalScheduler.stop();
  shopifyPendingCleanup.stop();
  console.log('HTTP server closed.');
  process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

startServer();
