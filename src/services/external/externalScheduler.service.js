const crypto = require('crypto');
const ownSource = require('./ownSource.service');
const externalImport = require('./externalImport.service');

/**
 * Portal-driven scheduler for Own Source feeds (design §8.2). This is a DELIBERATE departure from
 * the app's "no internal cron — n8n drives everything" rule, justified because Own Sources is
 * self-serve: a user sets "every 6 hours" / "daily 03:00" in the UI and the portal must just run
 * it, no n8n wiring.
 *
 * Mechanism — in-process tick + persisted `nextRunAt` + Mongo claim-lock (no extra infra):
 *   1. A timer fires every ~60 s.
 *   2. Each tick ATOMICALLY claims due feeds (`ownSource.claimDueSource`) so a run can't double-
 *      fire — correct even if the API scales to >1 instance (the atomic findOneAndUpdate IS the
 *      lock; no broker, no leader election). It loops until nothing is due.
 *   3. Each claimed feed runs through the SAME per-feed import path as a manual run, then
 *      `recordHealth` recomputes + persists `nextRunAt` and clears the lock.
 *   4. On crash, the stale `lockedUntil` expires and the feed is reclaimed — no lost schedule.
 *
 * `nextRunAt` is persisted, so a process restart resumes exactly where it left off. Set
 * `EXTERNAL_SCHEDULER=off` to disable the ticker (e.g. on all-but-one instance when scaling out).
 */

const TICK_MS = 60 * 1000;
const LOCK_MS = 10 * 60 * 1000; // a claim auto-expires after this if a run dies mid-flight
const INSTANCE_ID = `api_${crypto.randomBytes(4).toString('hex')}`;

let timer = null;
let ticking = false;

/** Runs one scheduler pass: drain every due feed. */
async function tick() {
    if (ticking) return; // never overlap ticks
    ticking = true;
    try {
        const now = Date.now();
        let claimed;
        // Loop so several due feeds in one tick all run; claimDueSource returns null when dry.
        while ((claimed = await ownSource.claimDueSource(now, INSTANCE_ID, LOCK_MS))) {
            const feedId = claimed.feedId;
            try {
                // Same per-feed queue path as a manual run → no overlap with an in-flight import.
                await externalImport.startImport(feedId, { trigger: 'schedule' });
            } catch (err) {
                if (err.code === 'SYNC_BUSY') {
                    // A manual import is running; leave the claim to expire and re-fire next tick.
                    console.log(`[external] scheduler: ${feedId} busy, will retry`);
                } else {
                    console.error(`[external] scheduler run for ${feedId} failed:`, err.message);
                    await ownSource.recordHealth(feedId, { result: 'fetch_error', error: { code: 'SCHEDULER_ERROR', message: err.message } });
                }
            }
        }
    } catch (err) {
        console.error('[external] scheduler tick error:', err.message);
    } finally {
        ticking = false;
    }
}

/** Starts the scheduler (called once from index.js after the DB connects). */
function start() {
    if (process.env.EXTERNAL_SCHEDULER === 'off') {
        console.log('[external] scheduler disabled (EXTERNAL_SCHEDULER=off).');
        return;
    }
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (timer.unref) timer.unref(); // don't keep the process alive for the timer alone
    console.log(`[external] scheduler started (instance ${INSTANCE_ID}, tick ${TICK_MS / 1000}s).`);
    // Kick an immediate pass so a feed due at boot doesn't wait a full tick.
    tick().catch(() => {});
}

/** Stops the scheduler (tests / graceful shutdown). */
function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, INSTANCE_ID };
