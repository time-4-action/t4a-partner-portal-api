const { runPnvProductSync } = require('../services/pnv/pnvProductsSync.service');
const { identifyProductCategories } = require('../services/ai/categoryIdentification.service');
const { getAiEnabledExports } = require('../services/exports.service');

/**
 * POST /api/export/webhooks/sync/pnv
 *
 * Triggers a full PNV product sync:
 * - authenticates with PNV, downloads the latest products CSV
 * - processes and enriches data with Metakocka stock/prices
 * - upserts results into MongoDB
 *
 * Responds immediately with 202 and runs the job in the background
 * so that callers (e.g. n8n) do not time out on long-running syncs.
 */
exports.triggerPnvSync = (req, res) => {
    res.status(202).json({
        message: 'PNV product sync started.',
        startedAt: new Date().toISOString()
    });

    runPnvProductSync().catch(err => {
        console.error('[webhook] PNV sync failed:', err.message);
    });
};

/**
 * POST /api/export/webhooks/sync/ai-categorization
 *
 * Triggers AI category identification for products that have not yet been categorized.
 *
 * Optionally accepts a JSON body with an exportId to limit the run to a single export:
 *   { "exportId": "<mongo ObjectId string>" }
 *
 * If no exportId is provided, it runs for every export that has aiCategorizationEnabled: true.
 *
 * Responds immediately with 202 and runs in the background.
 */
exports.triggerAiCategorization = async (req, res) => {
    const { exportId } = req.body || {};

    if (exportId) {
        res.status(202).json({
            message: `AI categorization started for exportId: ${exportId}.`,
            startedAt: new Date().toISOString()
        });

        identifyProductCategories(exportId).catch(err => {
            console.error(`[webhook] AI categorization failed for exportId ${exportId}:`, err.message);
        });
    } else {
        // Run for all AI-enabled exports
        let exports;
        try {
            exports = await getAiEnabledExports();
        } catch (err) {
            console.error('[webhook] Failed to fetch AI-enabled exports:', err.message);
            return res.status(500).json({ message: 'Failed to fetch AI-enabled exports.' });
        }

        res.status(202).json({
            message: `AI categorization started for ${exports.length} export(s).`,
            exportIds: exports.map(e => e._id.toString()),
            startedAt: new Date().toISOString()
        });

        (async () => {
            for (const _export of exports) {
                await identifyProductCategories(_export._id.toString()).catch(err => {
                    console.error(`[webhook] AI categorization failed for exportId ${_export._id}:`, err.message);
                });
            }
        })();
    }
};
