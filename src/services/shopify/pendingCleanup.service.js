const connectionService = require('./shopifyConnection.service');
const tokenService = require('./shopifyToken.service');
const shopifyApi = require('./shopifyApi.service');

/**
 * Periodic cleanup of abandoned PENDING Shopify connections.
 *
 * A Shopify-initiated install creates a `pending` connection (we hold the access token) until an
 * approved partner signs in and claims it, or a non-approved user declines it. A merchant who
 * installs but never signs into the portal (e.g. only uses the request-access form) would otherwise
 * leave us holding a Shopify token for an unbound store indefinitely. This sweep self-uninstalls +
 * deletes any pending connection older than PENDING_TTL_MS, so no token outlives its usefulness.
 *
 * Deliberately lightweight: a ~10-min interval, no cron/claim-lock — the operations are idempotent
 * and best-effort, so a double-run across instances is harmless (a second uninstall 401s; a second
 * delete is a no-op). Contrast the PNV/Own-Sources schedulers, which need exactly-once slot claims.
 */

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 60 * 60 * 1000; // a pending install older than this was abandoned

let timer = null;

/** Uninstalls + deletes every pending connection older than the TTL. Best-effort per connection. */
async function runSweep() {
    const cutoff = new Date(Date.now() - PENDING_TTL_MS);
    let stale;
    try {
        stale = await connectionService.findStalePending(cutoff);
    } catch (err) {
        console.error('[shopify-cleanup] could not list stale pending connections:', err.message);
        return { swept: 0 };
    }
    if (!stale.length) return { swept: 0 };

    let swept = 0;
    for (const conn of stale) {
        // Best-effort self-uninstall so the app is removed from the merchant's admin too. The token
        // may already be invalid (manual uninstall) — we still drop our row below either way.
        try {
            const token = await tokenService.getValidAccessToken(conn._id);
            await shopifyApi.uninstallApp(conn.shopDomain, token);
        } catch (err) {
            console.warn(`[shopify-cleanup] uninstall failed for ${conn.shopDomain} (continuing):`, err.code || err.message);
        }
        try {
            await connectionService.deleteConnection(conn._id.toString());
            swept++;
        } catch (err) {
            console.error(`[shopify-cleanup] delete failed for ${conn.shopDomain}:`, err.message);
        }
    }
    if (swept) console.log(`[shopify-cleanup] swept ${swept} abandoned pending connection(s).`);
    return { swept };
}

/** Starts the sweep (called once from index.js after the DB connects). */
function start() {
    if (timer) return;
    timer = setInterval(() => {
        runSweep().catch((err) => console.error('[shopify-cleanup] sweep error:', err.message));
    }, SWEEP_INTERVAL_MS);
    if (timer.unref) timer.unref(); // don't keep the process alive for the timer alone
    console.log(`[shopify-cleanup] started (sweep every ${SWEEP_INTERVAL_MS / 60000} min, pending TTL ${PENDING_TTL_MS / 60000} min).`);
    // Run once shortly after boot so a long downtime doesn't leave stale rows until the first tick.
    runSweep().catch(() => {});
}

/** Stops the sweep (tests / graceful shutdown). */
function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runSweep };
