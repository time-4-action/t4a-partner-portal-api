const crypto = require('crypto');
const { CronExpressionParser } = require('cron-parser');
const { getDb } = require('../db/mongo.service');
const { runPnvProductSync } = require('./pnvProductsSync.service');
const { identifyProductCategories } = require('../ai/categoryIdentification.service');
const { getAiEnabledExports } = require('../../services/exports.service');
const { syncAllConnections } = require('../shopify/shopifySync.service');

/**
 * In-app scheduler for the PNV catalogue refresh — replaces the n8n cron.
 *
 * Driven by the `PRODUCTS_DOWNLOAD_SCHEDULE` env var (standard 5-field cron, e.g. `0 * * * *`
 * for hourly). Unset / empty / `off` disables the scheduler entirely (the
 * `POST /webhooks/sync/pnv` n8n endpoint keeps working either way).
 *
 * Each scheduled refresh runs the full catalogue pipeline IN ORDER:
 *   1. PNV product sync (download → parse → Metakocka enrich → upsert)
 *   2. AI categorization for every AI-enabled category set (so new products get categories
 *      BEFORE they're pushed — tags depend on them)
 *   3. Shopify push fan-out across all connected stores (trigger 'pnv')
 *
 * Mechanism mirrors the Own Sources scheduler (externalScheduler.service.js): a ~30 s tick +
 * a persisted `nextRunAt` + an atomic Mongo claim-lock in the `scheduler_state` collection.
 * That makes it restart-safe (a missed slot while the API was down fires once at boot) and
 * multi-instance-safe (the findOneAndUpdate IS the lock — only one instance claims a slot;
 * a crashed run's lock expires after LOCK_MS and the next slot is recomputed).
 */

const STATE_COLLECTION = 'scheduler_state';
const STATE_ID = 'pnv-products-sync';

const TICK_MS = 30 * 1000;
// PNV download + Metakocka enrichment + AI categorization can legitimately take a while —
// the claim only expires (allowing a re-claim) if a run dies without finishing.
const LOCK_MS = 90 * 60 * 1000;
const INSTANCE_ID = `api_${crypto.randomBytes(4).toString('hex')}`;

let timer = null;
let ticking = false;

/** The configured cron expression, or null when the scheduler is disabled. */
function configuredSchedule() {
    const raw = (process.env.PRODUCTS_DOWNLOAD_SCHEDULE || '').trim();
    if (!raw || raw.toLowerCase() === 'off') return null;
    return raw;
}

/** Next occurrence of the cron expression strictly after `from`. */
function nextRunAfter(schedule, from = new Date()) {
    return CronExpressionParser.parse(schedule, { currentDate: from }).next().toDate();
}

/**
 * Ensures the persisted state matches the configured schedule. A changed cron expression
 * recomputes `nextRunAt`; an unchanged one keeps it (including a PAST one — that's the
 * restart-safe "missed while down → run once at boot" behavior).
 */
async function ensureState(schedule) {
    const col = getDb().collection(STATE_COLLECTION);
    const existing = await col.findOne({ _id: STATE_ID });
    if (!existing || existing.schedule !== schedule || !existing.nextRunAt) {
        const nextRunAt = nextRunAfter(schedule);
        await col.updateOne(
            { _id: STATE_ID },
            { $set: { schedule, nextRunAt, updatedAt: new Date() }, $setOnInsert: { lockedUntil: null, runningBy: null } },
            { upsert: true }
        );
        console.log(`[pnv-scheduler] schedule "${schedule}" — next run ${nextRunAt.toISOString()}`);
    } else {
        console.log(`[pnv-scheduler] schedule "${schedule}" — next run ${new Date(existing.nextRunAt).toISOString()} (persisted)`);
    }
}

/** Atomically claims a due slot. Returns the state doc when claimed, null otherwise. */
async function claimDueSlot(nowMs) {
    const now = new Date(nowMs);
    return getDb().collection(STATE_COLLECTION).findOneAndUpdate(
        {
            _id: STATE_ID,
            nextRunAt: { $ne: null, $lte: now },
            $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }]
        },
        { $set: { lockedUntil: new Date(nowMs + LOCK_MS), runningBy: INSTANCE_ID, lastStartedAt: now } }
    );
}

/** Records the run outcome, advances `nextRunAt` from NOW (no burst catch-up), frees the lock. */
async function finishSlot(schedule, { result, error = null, stats = null, startedAt }) {
    const now = new Date();
    await getDb().collection(STATE_COLLECTION).updateOne(
        { _id: STATE_ID },
        {
            $set: {
                nextRunAt: nextRunAfter(schedule, now),
                lockedUntil: null,
                runningBy: null,
                lastFinishedAt: now,
                lastDurationMs: startedAt ? now - startedAt : null,
                lastResult: result,
                lastError: error,
                lastStats: stats,
                updatedAt: now
            }
        }
    );
}

/**
 * The full scheduled catalogue refresh: PNV sync → AI categorization → Shopify push.
 * AI/Shopify failures are logged but never fail the run — the catalogue itself synced.
 */
async function runScheduledRefresh() {
    console.log('[pnv-scheduler] catalogue refresh starting…');
    const stats = await runPnvProductSync();
    console.log(`[pnv-scheduler] PNV sync done — ${stats.totalProcessed} processed (${stats.created} created, ${stats.updated} updated, ${stats.deactivated} deactivated)`);

    // AI categorization for every AI-enabled category set — BEFORE the Shopify push so newly
    // created products carry their categories (tags) on the first push.
    let aiRuns = [];
    try {
        const aiExports = await getAiEnabledExports();
        for (const exp of aiExports) {
            const id = exp._id.toString();
            try {
                const r = await identifyProductCategories(id);
                aiRuns.push({ exportId: id, categorized: r.productsCategorized });
                console.log(`[pnv-scheduler] AI categorization "${exp.name || id}": ${r.productsCategorized}/${r.productsFound} categorized`);
            } catch (err) {
                aiRuns.push({ exportId: id, error: err.message });
                console.error(`[pnv-scheduler] AI categorization failed for ${id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[pnv-scheduler] could not list AI-enabled category sets:', err.message);
    }

    // Near-live Shopify push across every connected store. The fan-out call returns once the
    // background runs are started (each serialized per shop) — we don't wait for the pushes.
    try {
        const results = await syncAllConnections({ trigger: 'pnv' });
        console.log(`[pnv-scheduler] Shopify push started for ${results.length} connection(s)`);
    } catch (err) {
        console.error('[pnv-scheduler] Shopify push fan-out failed:', err.message);
    }

    return {
        totalProcessed: stats.totalProcessed,
        created: stats.created,
        updated: stats.updated,
        deactivated: stats.deactivated,
        aiRuns
    };
}

/** One scheduler pass: claim the slot if due, run the refresh, advance the schedule. */
async function tick() {
    if (ticking) return; // never overlap ticks in-process
    ticking = true;
    try {
        const schedule = configuredSchedule();
        if (!schedule) return;
        const claimed = await claimDueSlot(Date.now());
        if (!claimed) return;

        const startedAt = new Date();
        try {
            const stats = await runScheduledRefresh();
            await finishSlot(schedule, { result: 'ok', stats, startedAt });
            console.log('[pnv-scheduler] catalogue refresh finished.');
        } catch (err) {
            console.error('[pnv-scheduler] catalogue refresh failed:', err.message);
            await finishSlot(schedule, { result: 'error', error: err.message, startedAt });
        }
    } catch (err) {
        console.error('[pnv-scheduler] tick error:', err.message);
    } finally {
        ticking = false;
    }
}

/** Starts the scheduler (called once from index.js after the DB connects). */
async function start() {
    const schedule = configuredSchedule();
    if (!schedule) {
        console.log('[pnv-scheduler] disabled (PRODUCTS_DOWNLOAD_SCHEDULE not set).');
        return;
    }
    try {
        CronExpressionParser.parse(schedule); // fail fast on a bad expression
    } catch (err) {
        console.error(`[pnv-scheduler] INVALID cron "${schedule}" — scheduler NOT started:`, err.message);
        return;
    }
    if (timer) return;
    await ensureState(schedule);
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (timer.unref) timer.unref(); // don't keep the process alive for the timer alone
    console.log(`[pnv-scheduler] started (instance ${INSTANCE_ID}, tick ${TICK_MS / 1000}s).`);
    // Immediate pass so a slot missed while the API was down fires at boot, not a tick later.
    tick().catch(() => {});
}

/** Stops the scheduler (tests / graceful shutdown). */
function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, runScheduledRefresh, INSTANCE_ID };
