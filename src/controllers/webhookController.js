const { runPnvProductSync } = require('../services/pnv/pnvProductsSync.service');
const { identifyProductCategories, categorizeExternalProducts } = require('../services/ai/categoryIdentification.service');
const { getAiEnabledExports } = require('../services/exports.service');
const { fireCallback } = require('../services/callbackWebhook.service');
const { syncAllConnections } = require('../services/shopify/shopifySync.service');
const externalImport = require('../services/external/externalImport.service');

/**
 * POST /api/export/webhooks/sync/pnv
 *
 * Triggers a full PNV product sync in the background.
 * Responds immediately with 202. When the sync finishes (success or failure),
 * POSTs a result payload to webhook_url if provided in the request body.
 */
exports.triggerPnvSync = (req, res) => {
    const { webhook } = req.body || {};
    const startedAt = new Date();

    res.status(202).json({
        message: 'PNV product sync started.',
        startedAt: startedAt.toISOString(),
    });

    console.log(`[pnv-sync] Started. Callback URL: ${webhook || 'none'}`);

    (async () => {
        try {
            const stats = await runPnvProductSync();
            const finishedAt = new Date();

            // Near-live trigger (design §8.1): once the catalogue is refreshed, push to every
            // connected Shopify store. Fire-and-forget so it never delays the PNV callback.
            syncAllConnections({ trigger: 'pnv' })
                .then((r) => console.log(`[shopify] PNV-triggered sync started for ${r.length} connection(s)`))
                .catch((e) => console.error('[shopify] PNV-triggered sync error:', e.message));

            await fireCallback(webhook, {
                event: 'pnv_sync_completed',
                success: true,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs: finishedAt - startedAt,
                stats: {
                    totalProcessed: stats.totalProcessed,
                    productsCreated: stats.created,
                    productsUpdated: stats.updated,
                    productsDeactivated: stats.deactivated,
                },
            });

        } catch (err) {
            const finishedAt = new Date();
            console.error('[webhook] PNV sync failed:', err.message);

            await fireCallback(webhook, {
                event: 'pnv_sync_completed',
                success: false,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs: finishedAt - startedAt,
                error: err.message,
            });
        }
    })();
};

/**
 * POST /api/export/webhooks/sync/ai-categorization
 *
 * Triggers AI categorization in the background for all AI-enabled exports,
 * or a specific one if { "exportId": "..." } is passed in the request body.
 * Responds immediately with 202. When done, POSTs a result payload to
 * webhook_url if provided in the request body.
 */
/**
 * POST /api/export/webhooks/sync/shopify
 *
 * Triggers a full Shopify reconcile across every connected store (design §8.1) — meant to be
 * called on a schedule by n8n. Each store's run is kicked off in the background (serialized
 * per shop); responds 202 with the per-connection start results.
 */
exports.triggerShopifyReconcile = async (req, res) => {
    try {
        const results = await syncAllConnections({ trigger: 'reconcile' });
        res.status(202).json({
            message: `Shopify reconcile started for ${results.length} connection(s).`,
            startedAt: new Date().toISOString(),
            results
        });
    } catch (err) {
        console.error('[webhook] Shopify reconcile failed:', err.message);
        res.status(500).json({ message: err.message });
    }
};

/**
 * POST /api/export/webhooks/sync/external
 *
 * Escape hatch for an external nudge/back-fill of an Own Source feed (design §8.2). The portal's
 * own scheduler is the real driver; this is NOT it. `webhookApiKey`-protected. Body `{ feedId }`
 * triggers one feed; the import records its own outcome and triggers the Shopify push on success.
 */
exports.triggerExternalImport = (req, res) => {
    const { feedId } = req.body || {};
    if (!feedId) {
        return res.status(400).json({ message: 'feedId is required.' });
    }
    externalImport.startImport(feedId, { trigger: 'webhook' }).catch((err) => {
        console.error(`[webhook] external import for ${feedId} failed:`, err.message);
    });
    res.status(202).json({ message: `Import started for feed ${feedId}.`, startedAt: new Date().toISOString() });
};

/**
 * POST /api/export/webhooks/categorize
 *
 * Synchronously categorizes an array of third-party products against an
 * existing category set (identified by exportId).  Nothing is persisted —
 * the results are returned in the response body.
 */
exports.categorizeExternal = async (req, res) => {
    const { exportId, products } = req.body || {};

    if (!exportId) {
        return res.status(400).json({ message: 'Missing required field: exportId' });
    }
    if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ message: 'Missing or empty required field: products (must be a non-empty array)' });
    }

    const MAX_PRODUCTS = 300;
    if (products.length > MAX_PRODUCTS) {
        return res.status(400).json({ message: `Too many products. Maximum is ${MAX_PRODUCTS} per request.` });
    }

    for (const p of products) {
        if (!p.code || !p.name) {
            return res.status(400).json({ message: 'Every product must have at least "code" and "name" fields.' });
        }
    }

    try {
        const result = await categorizeExternalProducts(exportId, products);
        return res.status(200).json(result);
    } catch (err) {
        console.error('[categorize-external] Error:', err.message);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * POST /api/export/webhooks/sync/ai-categorization
 *
 * Triggers AI categorization in the background for all AI-enabled exports,
 * or a specific one if { "exportId": "..." } is passed in the request body.
 * Responds immediately with 202. When done, POSTs a result payload to
 * webhook_url if provided in the request body.
 */
exports.triggerAiCategorization = async (req, res) => {
    const { exportId, webhook } = req.body || {};
    const startedAt = new Date();

    let exportsToRun;

    if (exportId) {
        exportsToRun = [{ _id: { toString: () => exportId } }];
    } else {
        try {
            exportsToRun = await getAiEnabledExports();
        } catch (err) {
            console.error('[webhook] Failed to fetch AI-enabled exports:', err.message);
            return res.status(500).json({ message: 'Failed to fetch AI-enabled exports.' });
        }
    }

    res.status(202).json({
        message: `AI categorization started for ${exportsToRun.length} export(s).`,
        exportIds: exportsToRun.map(e => e._id.toString()),
        startedAt: startedAt.toISOString(),
    });

    console.log(`[ai-categorization] Started for ${exportsToRun.length} export(s). Callback URL: ${webhook || 'none'}`);

    (async () => {
        const results = [];

        for (const _export of exportsToRun) {
            const id = _export._id.toString();
            const exportStartedAt = new Date();

            try {
                const stats = await identifyProductCategories(id);
                const exportFinishedAt = new Date();

                results.push({
                    exportId: id,
                    success: true,
                    durationMs: exportFinishedAt - exportStartedAt,
                    productsFound: stats.productsFound,
                    productsCategorized: stats.productsCategorized,
                });
            } catch (err) {
                const exportFinishedAt = new Date();
                console.error(`[webhook] AI categorization failed for exportId ${id}:`, err.message);

                results.push({
                    exportId: id,
                    success: false,
                    durationMs: exportFinishedAt - exportStartedAt,
                    error: err.message,
                });
            }
        }

        const finishedAt = new Date();
        const allSucceeded = results.every(r => r.success);

        await fireCallback(webhook, {
            event: 'ai_categorization_completed',
            success: allSucceeded,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt - startedAt,
            stats: {
                exportsProcessed: results.length,
                results,
            },
        });
    })();
};
