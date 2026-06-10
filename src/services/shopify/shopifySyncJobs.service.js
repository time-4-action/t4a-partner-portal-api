const { getDb } = require('../db/mongo.service');
const { ObjectId } = require('mongodb');

/**
 * Data-access layer for `shopify_sync_jobs` (design §6/§8.6).
 *
 * One document = one **sync run** (a manual "Sync now", a connect-time push, or a future
 * triggered/scheduled run). A run-grained model is deliberate: a per-variant row per sync
 * would bloat the collection (catalogue size × every run) with no upside — the per-variant
 * outcome that matters operationally is the *unmatched* report and the map state, both of
 * which live elsewhere. Each run carries its own counts and the unmatched/error lists from
 * that run, which is exactly what the partner UI's "Sync activity" + "Needs attention"
 * panels render.
 *
 * Index `{connectionId, status}` is created at startup in shopifyConnection.service.
 */

const COLLECTION_NAME = 'shopify_sync_jobs';

const toObjectId = (id) => (id instanceof ObjectId ? id : new ObjectId(id));

const EMPTY_COUNTS = { inScope: 0, matched: 0, pushed: 0, unmatched: 0, failed: 0, pricesPushed: 0, contentPushed: 0, imagesPushed: 0, publishedProducts: 0, createdProducts: 0, createdVariants: 0 };

/**
 * Opens a run in `running` state. Returned immediately to the controller so the HTTP
 * response can hand the UI a job id to poll while the push proceeds in the background.
 *
 * @param {ObjectId|string} connectionId
 * @param {string} shopDomain
 * @param {{ type?: string, trigger?: string }} [opts]
 * @returns {Promise<Object>} the inserted job document
 */
async function startRun(connectionId, shopDomain, { type = 'inventory', trigger = 'manual' } = {}) {
    const now = new Date();
    const doc = {
        connectionId: toObjectId(connectionId),
        shopDomain,
        type,
        trigger,
        status: 'running',
        attempts: 1,
        counts: { ...EMPTY_COUNTS },
        unmatched: [],
        errors: [],
        error: null,
        startedAt: now,
        finishedAt: null,
        createdAt: now,
        updatedAt: now
    };
    const result = await getDb().collection(COLLECTION_NAME).insertOne(doc);
    return { ...doc, _id: result.insertedId };
}

/**
 * Closes a run. `status` is 'done' on a clean push, 'partial' when some items were
 * unmatched/failed, or 'failed' when the run aborted before pushing.
 *
 * @param {ObjectId|string} jobId
 * @param {{ status:string, counts?:Object, unmatched?:Array, errors?:Array, error?:string|null }} result
 */
async function finishRun(jobId, { status, counts, unmatched, errors, error }) {
    const now = new Date();
    await getDb().collection(COLLECTION_NAME).updateOne(
        { _id: toObjectId(jobId) },
        {
            $set: {
                status,
                counts: { ...EMPTY_COUNTS, ...(counts || {}) },
                unmatched: unmatched || [],
                errors: errors || [],
                error: error || null,
                finishedAt: now,
                updatedAt: now
            }
        }
    );
}

/**
 * Returns the most recent runs for a connection, newest first.
 * @param {ObjectId|string} connectionId
 * @param {number} [limit]
 * @returns {Promise<Object[]>}
 */
async function listRecentRuns(connectionId, limit = 20) {
    return getDb()
        .collection(COLLECTION_NAME)
        .find({ connectionId: toObjectId(connectionId) })
        .sort({ startedAt: -1 })
        .limit(limit)
        .toArray();
}

/**
 * The latest run for a connection, or null. Source of the live "Needs attention" report.
 * @param {ObjectId|string} connectionId
 * @returns {Promise<Object|null>}
 */
async function getLatestRun(connectionId) {
    const [run] = await getDb()
        .collection(COLLECTION_NAME)
        .find({ connectionId: toObjectId(connectionId) })
        .sort({ startedAt: -1 })
        .limit(1)
        .toArray();
    return run || null;
}

/**
 * Marks any still-`running` runs for a connection as failed. Called at startup-adjacent
 * points / before a new run so a process crash mid-sync can't leave a zombie "running" row
 * spinning in the UI forever.
 * @param {ObjectId|string} connectionId
 */
async function failStaleRuns(connectionId) {
    const now = new Date();
    await getDb().collection(COLLECTION_NAME).updateMany(
        { connectionId: toObjectId(connectionId), status: 'running' },
        { $set: { status: 'failed', error: 'Interrupted — superseded by a new run', finishedAt: now, updatedAt: now } }
    );
}

/**
 * Removes every sync-run record for a connection. Called on portal disconnect and on the
 * `shop/redact` GDPR webhook so no run history (shop domain, SKU lists) outlives the
 * connection it belongs to.
 * @param {ObjectId|string} connectionId
 */
async function deleteForConnection(connectionId) {
    await getDb().collection(COLLECTION_NAME).deleteMany({ connectionId: toObjectId(connectionId) });
}

module.exports = {
    COLLECTION_NAME,
    EMPTY_COUNTS,
    startRun,
    finishRun,
    listRecentRuns,
    getLatestRun,
    failStaleRuns,
    deleteForConnection
};
