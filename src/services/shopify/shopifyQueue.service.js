/**
 * Per-shop rate-limited queue primitives for the sync engine (design §8.5).
 *
 * Two concerns, kept deliberately small (the design says "start simple — an in-process
 * queue; only reach for a worker/broker if volume demands it"):
 *
 *   1. {@link runExclusive} — serialize work *per shop*. Two sync runs for the same store
 *      must never overlap (they would race on the same inventory items and double-count
 *      throttle budget). Runs for *different* shops still proceed in parallel.
 *
 *   2. {@link mapWithConcurrency} — a bounded-concurrency map so a single run can push
 *      batches a few at a time instead of all-at-once, keeping us under Shopify's cost
 *      bucket. The GraphQL client's own throttle backoff is the second line of defence.
 *
 * State is in-process. A single API instance is assumed (matches the existing app, which
 * has no internal scheduler — n8n drives recurring work externally).
 */

/** Tail of the currently-running/queued promise chain, keyed by shop domain. */
const shopChains = new Map();

/** Max GraphQL batches a single sync run fires concurrently. */
const DEFAULT_CONCURRENCY = 2;

/**
 * Runs `fn` exclusively for a given shop: calls for the same `shopDomain` are chained so
 * only one executes at a time, in arrival order. Calls for different shops don't block
 * each other. The chain self-cleans when it drains so the Map can't grow unbounded.
 *
 * @template T
 * @param {string} shopDomain
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runExclusive(shopDomain, fn) {
    const prev = shopChains.get(shopDomain) || Promise.resolve();
    // Swallow the predecessor's result/rejection — each caller only sees its own outcome.
    const run = prev.catch(() => {}).then(() => fn());
    // The stored tail must never reject (it's only used for sequencing).
    const tail = run.catch(() => {});
    shopChains.set(shopDomain, tail);
    // Drop the entry once this is the last link, so idle shops don't linger in the Map.
    tail.finally(() => {
        if (shopChains.get(shopDomain) === tail) shopChains.delete(shopDomain);
    });
    return run;
}

/**
 * True when a sync is already in flight for the shop (used to reject overlapping manual
 * "Sync now" clicks fast, rather than silently queueing a second full run behind the first).
 */
function isBusy(shopDomain) {
    return shopChains.has(shopDomain);
}

/**
 * Maps `items` through async `fn` with at most `limit` in flight at once, preserving
 * input order in the results. Rejects on the first error (the sync orchestrator wraps
 * per-batch work in try/catch so one bad batch is recorded, not fatal).
 *
 * @template I, O
 * @param {I[]} items
 * @param {(item: I, index: number) => Promise<O>} fn
 * @param {number} [limit]
 * @returns {Promise<O[]>}
 */
async function mapWithConcurrency(items, fn, limit = DEFAULT_CONCURRENCY) {
    const results = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));

    const worker = async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await fn(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

module.exports = {
    runExclusive,
    isBusy,
    mapWithConcurrency,
    DEFAULT_CONCURRENCY
};
