const { runPnvProductSync } = require('../services/pnv/pnvProductsSync.service');
const { identifyProductCategories } = require('../services/ai/categoryIdentification.service');
const { getAiEnabledExports } = require('../services/exports.service');
const { fireCallback } = require('../services/callbackWebhook.service');

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
