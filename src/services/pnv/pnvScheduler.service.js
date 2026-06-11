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

// Periodic "still armed" log so liveness is visible without waiting for an actual run. Throttled
// so the 30 s tick doesn't spam the log; first tick after boot logs immediately (lastHeartbeatMs=0).
const HEARTBEAT_MS = 10 * 60 * 1000;
let lastHeartbeatMs = 0;

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

/**
 * Releases a run-lock left behind by a PREVIOUS process. A run that was claimed but never
 * reached finishSlot (crash, OOM, or — most commonly — a redeploy mid-pipeline) leaves
 * `lockedUntil` up to LOCK_MS (90 min) in the future with `runningBy` pointing at the now-dead
 * process. ensureState never clears it (lock fields are `$setOnInsert` only), so the next due
 * slot can't be claimed until the lock expires — the scheduler looks dead for up to 90 minutes,
 * even across a restart and even after the schedule is changed. We just booted as a fresh
 * process, so any persisted lock is by definition orphaned (this design ticks on ONE instance).
 * Clear it so the next due slot fires immediately.
 */
async function releaseOrphanLock() {
    const res = await getDb().collection(STATE_COLLECTION).updateOne(
        { _id: STATE_ID, runningBy: { $ne: null } },
        { $set: { lockedUntil: null, runningBy: null } }
    );
    if (res.modifiedCount) {
        console.log('[pnv-scheduler] cleared an orphaned run-lock from a previous process (a run was interrupted mid-flight).');
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

/**
 * Logs a throttled "armed" heartbeat (at most every HEARTBEAT_MS) showing the next run time and
 * how long until it's due — so an operator can confirm the scheduler is alive between runs, and
 * spot a stuck/future nextRunAt or a held lock without reading the DB.
 */
async function heartbeat(nowMs) {
    if (nowMs - lastHeartbeatMs < HEARTBEAT_MS) return;
    lastHeartbeatMs = nowMs;
    try {
        const st = await getDb().collection(STATE_COLLECTION)
            .findOne({ _id: STATE_ID }, { projection: { nextRunAt: 1, lockedUntil: 1, runningBy: 1 } });
        if (!st?.nextRunAt) {
            console.log('[pnv-scheduler] armed — no nextRunAt set yet.');
            return;
        }
        const dueInS = Math.round((new Date(st.nextRunAt).getTime() - nowMs) / 1000);
        const locked = st.runningBy && st.lockedUntil && new Date(st.lockedUntil).getTime() > nowMs
            ? ` — RUN IN PROGRESS (locked by ${st.runningBy} until ${new Date(st.lockedUntil).toISOString()})`
            : '';
        console.log(`[pnv-scheduler] armed — next run ${new Date(st.nextRunAt).toISOString()} (${dueInS >= 0 ? `in ${dueInS}s` : `${-dueInS}s overdue`})${locked}`);
    } catch (err) {
        console.error('[pnv-scheduler] heartbeat read failed:', err.message);
    }
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
    const startedMs = Date.now();
    const secsSince = (fromMs) => ((Date.now() - fromMs) / 1000).toFixed(1);
    console.log('[pnv-scheduler] ════════ catalogue refresh starting ════════');

    // ── Stage 1/3: PNV catalogue sync (download → parse → Metakocka enrich → upsert) ──
    console.log('[pnv-scheduler] [1/3] PNV product sync starting…');
    const pnvMs = Date.now();
    const stats = await runPnvProductSync();
    console.log(`[pnv-scheduler] [1/3] PNV sync done in ${secsSince(pnvMs)}s — ${stats.totalProcessed} processed (${stats.created} created, ${stats.updated} updated, ${stats.deactivated} deactivated)`);

    // ── Stage 2/3: AI categorization for every AI-enabled category set — BEFORE the Shopify push
    // so newly created products carry their categories (tags) on the first push. ──
    console.log('[pnv-scheduler] [2/3] AI categorization starting…');
    const aiMs = Date.now();
    let aiRuns = [];
    let aiTotalCategorized = 0;
    try {
        const aiExports = await getAiEnabledExports();
        console.log(`[pnv-scheduler] [2/3] ${aiExports.length} AI-enabled category set(s) to process`);
        for (const exp of aiExports) {
            const id = exp._id.toString();
            const label = exp.name || id;
            try {
                const expMs = Date.now();
                const r = await identifyProductCategories(id);
                aiRuns.push({ exportId: id, categorized: r.productsCategorized });
                aiTotalCategorized += r.productsCategorized || 0;
                console.log(`[pnv-scheduler] [2/3]   "${label}": ${r.productsCategorized}/${r.productsFound} categorized in ${secsSince(expMs)}s`);
            } catch (err) {
                aiRuns.push({ exportId: id, error: err.message });
                console.error(`[pnv-scheduler] [2/3]   "${label}" FAILED:`, err.message);
            }
        }
        console.log(`[pnv-scheduler] [2/3] AI categorization done in ${secsSince(aiMs)}s — ${aiTotalCategorized} product(s) categorized across ${aiExports.length} set(s)`);
    } catch (err) {
        console.error('[pnv-scheduler] [2/3] could not list AI-enabled category sets:', err.message);
    }

    // ── Stage 3/3: near-live Shopify push across every connected store. The fan-out call returns
    // once the background runs are STARTED (each serialized per shop) — we don't wait for the
    // pushes themselves; per-store progress is logged by the Shopify sync engine. ──
    console.log('[pnv-scheduler] [3/3] Shopify push fan-out starting…');
    const shopMs = Date.now();
    try {
        const results = await syncAllConnections({ trigger: 'pnv' });
        const started = results.filter((r) => r.jobId);
        const skipped = results.filter((r) => !r.jobId);
        console.log(`[pnv-scheduler] [3/3] Shopify fan-out done in ${secsSince(shopMs)}s — ${started.length} started, ${skipped.length} skipped (${results.length} connection(s))`);
        for (const r of started) {
            console.log(`[pnv-scheduler] [3/3]   started ${r.shop} (job ${r.jobId})`);
        }
        for (const r of skipped) {
            console.log(`[pnv-scheduler] [3/3]   skipped ${r.shop}: ${r.skipped}`);
        }
    } catch (err) {
        console.error('[pnv-scheduler] [3/3] Shopify push fan-out failed:', err.message);
    }

    console.log(`[pnv-scheduler] ════════ refresh pipeline complete in ${secsSince(startedMs)}s ════════`);

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
        const nowMs = Date.now();
        const claimed = await claimDueSlot(nowMs);
        if (!claimed) { await heartbeat(nowMs); return; }

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
    // Heal a lock orphaned by an interrupted previous run BEFORE the first tick, so a slot that
    // came due while we were down (or during a redeploy) can be claimed right away.
    await releaseOrphanLock();
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
