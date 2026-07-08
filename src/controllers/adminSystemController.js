const { getDb } = require('../services/db/mongo.service');
const pnvScheduler = require('../services/pnv/pnvScheduler.service');
const pendingCleanup = require('../services/shopify/pendingCleanup.service');
const externalImport = require('../services/external/externalImport.service');

/**
 * Read/trigger surface for the t4a-admin "Catalogue Sync" page. Gated by internalAdminToken
 * (shared bearer), it exposes the in-app schedulers' status + history and lets an admin trigger
 * a run on demand — without the admin app ever touching MongoDB directly. No secrets are returned.
 */

/** Own Sources scheduler enabled? Mirrors externalScheduler.service.js's EXTERNAL_SCHEDULER gate. */
function ownSourcesEnabled() {
    return (process.env.EXTERNAL_SCHEDULER || '').trim().toLowerCase() !== 'off';
}

/**
 * GET /api/admin/system/sync
 * Unified status for all three in-app schedulers: the PNV catalogue refresh, the Own Sources feed
 * imports, and the Shopify pending-cleanup sweep.
 */
exports.syncStatus = async (req, res) => {
    try {
        const db = getDb();

        // ── PNV catalogue refresh (state doc + computed isRunning + run history) ──
        const pnv = await pnvScheduler.getStatus();

        // ── Own Sources: per-feed health summary + recent run history across all feeds ──
        const feedDocs = await db.collection('own_sources')
            .find({})
            .project({
                feedId: 1, brand: 1, ownerSub: 1, ownerEmail: 1, status: 1,
                'schedule.enabled': 1, 'schedule.frequency': 1, nextRunAt: 1,
                lockedUntil: 1, runningBy: 1, health: 1
            })
            .sort({ 'health.lastImportAt': -1 })
            .toArray();
        const now = Date.now();
        const feeds = feedDocs.map((f) => ({
            feedId: f.feedId,
            brand: f.brand || f.feedId,
            ownerEmail: f.ownerEmail || null,
            status: f.status || null,
            scheduleEnabled: !!f.schedule?.enabled,
            frequency: f.schedule?.frequency || null,
            nextRunAt: f.nextRunAt || null,
            isRunning: !!(f.runningBy && f.lockedUntil && new Date(f.lockedUntil).getTime() > now),
            health: {
                lastImportAt: f.health?.lastImportAt || null,
                lastResult: f.health?.lastResult || null,
                lastError: f.health?.lastError || null,
                counts: f.health?.counts || null
            }
        }));
        const ownSourceRuns = await db.collection('external_import_runs')
            .find({}).sort({ finishedAt: -1 }).limit(20).toArray();

        // ── Shopify pending-cleanup (best-effort sweep; minimal last-sweep state) ──
        const sweepState = await db.collection('scheduler_state').findOne({ _id: pendingCleanup.STATE_ID });
        const shopifyCleanup = {
            intervalMs: pendingCleanup.SWEEP_INTERVAL_MS,
            pendingTtlMs: pendingCleanup.PENDING_TTL_MS,
            lastSweepAt: sweepState?.lastSweepAt || null,
            lastRemoved: sweepState?.lastRemoved ?? null
        };

        res.json({
            success: true,
            pnv,
            ownSources: { enabled: ownSourcesEnabled(), feeds, runs: ownSourceRuns },
            shopifyCleanup
        });
    } catch (error) {
        console.error('[admin/system] syncStatus error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * POST /api/admin/system/sync/pnv/run
 * Triggers the full catalogue pipeline (PNV → AI → Shopify) on demand, identical to the cron.
 * 202 when started; 409 when a run (scheduled or manual) is already in progress.
 */
exports.runPnv = async (req, res) => {
    try {
        const result = await pnvScheduler.runManualRefresh();
        if (!result.started) {
            return res.status(409).json({ success: false, error: 'A catalogue refresh is already running.', reason: result.reason });
        }
        res.status(202).json({ success: true, message: 'Catalogue refresh started.', startedAt: result.startedAt });
    } catch (error) {
        console.error('[admin/system] runPnv error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * POST /api/admin/system/sync/own-sources/:feedId/run
 * Triggers one Own Source feed import on demand (reuses the same path the scheduler/webhook use).
 */
exports.runOwnSource = (req, res) => {
    const { feedId } = req.params;
    if (!feedId) {
        return res.status(400).json({ success: false, error: 'feedId is required.' });
    }
    if (externalImport.isBusy(feedId)) {
        return res.status(409).json({ success: false, error: 'An import is already running for this feed.' });
    }
    externalImport.startImport(feedId, { trigger: 'manual' }).catch((err) => {
        console.error(`[admin/system] own-source import for ${feedId} failed:`, err.message);
    });
    res.status(202).json({ success: true, message: `Import started for feed ${feedId}.`, startedAt: new Date().toISOString() });
};
