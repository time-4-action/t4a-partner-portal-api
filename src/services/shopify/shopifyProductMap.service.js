const { getDb } = require('../db/mongo.service');
const { ObjectId } = require('mongodb');

/**
 * Data-access layer for `shopify_product_map` (design §6/§7) — the link between one of our
 * variants (SKU) and its counterpart in a specific shop. Once a row exists it is
 * **authoritative**: future syncs read the stored Shopify ids instead of re-matching, so
 * only unmapped SKUs are ever looked up against the store again.
 *
 * Indexes (`{connectionId, sku}`, `{connectionId, parentCode}`) are created at startup in
 * {@link module:shopifyConnection.service.ensureIndexes}.
 */

const COLLECTION_NAME = 'shopify_product_map';

const toObjectId = (id) => (id instanceof ObjectId ? id : new ObjectId(id));

/**
 * Loads every map row for a connection, keyed by SKU for O(1) lookup during a sync.
 * @param {ObjectId|string} connectionId
 * @returns {Promise<Map<string, Object>>}
 */
async function getMapBySku(connectionId) {
    const db = getDb();
    const rows = await db
        .collection(COLLECTION_NAME)
        .find({ connectionId: toObjectId(connectionId) })
        .toArray();
    const bySku = new Map();
    for (const row of rows) bySku.set(row.sku, row);
    return bySku;
}

/**
 * Upserts freshly-matched variants into the map (keyed by connection + SKU). Only the
 * Shopify ids and identity fields are written here; push state is set separately by
 * {@link bulkSetState} after the inventory call so a match and its push outcome are
 * recorded independently.
 *
 * @param {ObjectId|string} connectionId
 * @param {string} shopDomain
 * @param {Array<{parentCode:string, variantCode:string|null, sku:string, barcode:string|null,
 *   shopifyProductId:string, shopifyVariantId:string, shopifyInventoryItemId:string}>} matches
 * @returns {Promise<number>} number of rows written
 */
async function bulkUpsertMatches(connectionId, shopDomain, matches) {
    if (!matches.length) return 0;
    const cid = toObjectId(connectionId);
    const now = new Date();
    const ops = matches.map((m) => ({
        updateOne: {
            filter: { connectionId: cid, sku: m.sku },
            update: {
                $set: {
                    connectionId: cid,
                    shopDomain,
                    parentCode: m.parentCode,
                    variantCode: m.variantCode,
                    sku: m.sku,
                    barcode: m.barcode || null,
                    shopifyProductId: m.shopifyProductId,
                    shopifyVariantId: m.shopifyVariantId,
                    shopifyInventoryItemId: m.shopifyInventoryItemId,
                    matchedAt: now,
                    updatedAt: now
                },
                $setOnInsert: { createdAt: now }
            },
            upsert: true
        }
    }));
    const result = await getDb().collection(COLLECTION_NAME).bulkWrite(ops, { ordered: false });
    return (result.upsertedCount || 0) + (result.modifiedCount || 0);
}

/**
 * Records the push outcome (state + optional error + lastHash/lastPushedAt) for a batch of
 * SKUs after the inventory mutation runs.
 *
 * @param {ObjectId|string} connectionId
 * `stockLocationId` records the location the item is currently stocked at (set after a
 * successful inventory activate) so later syncs can use the fast batched set there.
 * @param {Array<{sku:string, state:'synced'|'error'|'pending', error?:string|null, hash?:string|null, pushedAt?:Date|null, stockLocationId?:string}>} updates
 */
async function bulkSetState(connectionId, updates) {
    if (!updates.length) return;
    const cid = toObjectId(connectionId);
    const now = new Date();
    const ops = updates.map((u) => {
        const set = { state: u.state, error: u.error || null, updatedAt: now };
        if (u.hash !== undefined) set.lastHash = u.hash;
        if (u.stockLocationId !== undefined) set.stockLocationId = u.stockLocationId;
        if (u.state === 'synced') set.lastPushedAt = u.pushedAt || now;
        return {
            updateOne: { filter: { connectionId: cid, sku: u.sku }, update: { $set: set } }
        };
    });
    await getDb().collection(COLLECTION_NAME).bulkWrite(ops, { ordered: false });
}

/**
 * Sets delta hashes (priceHash / contentHash) on map rows after a successful content/price
 * push (Phase C). Kept separate from {@link bulkSetState} so a price/content update doesn't
 * disturb the row's stock sync state.
 * @param {ObjectId|string} connectionId
 * @param {Array<{sku:string, priceHash?:string, contentHash?:string, imageHash?:string}>} updates
 */
async function bulkSetHashes(connectionId, updates) {
    if (!updates.length) return;
    const cid = toObjectId(connectionId);
    const now = new Date();
    const ops = updates.map((u) => {
        const set = { updatedAt: now };
        if (u.priceHash !== undefined) set.priceHash = u.priceHash;
        if (u.contentHash !== undefined) set.contentHash = u.contentHash;
        if (u.imageHash !== undefined) set.imageHash = u.imageHash;
        if (u.imageMedia !== undefined) set.imageMedia = u.imageMedia; // [{url, mediaId}] — tracks our pushed images
        if (u.publishHash !== undefined) set.publishHash = u.publishHash;
        return { updateOne: { filter: { connectionId: cid, sku: u.sku }, update: { $set: set } } };
    });
    await getDb().collection(COLLECTION_NAME).bulkWrite(ops, { ordered: false });
}

/**
 * Aggregate of map state for the connection — feeds the UI's synced/error counters.
 * @param {ObjectId|string} connectionId
 * @returns {Promise<{ synced:number, error:number, total:number }>}
 */
async function getStateCounts(connectionId) {
    const db = getDb();
    const cid = toObjectId(connectionId);
    const rows = await db
        .collection(COLLECTION_NAME)
        .aggregate([{ $match: { connectionId: cid } }, { $group: { _id: '$state', n: { $sum: 1 } } }])
        .toArray();
    const counts = { synced: 0, error: 0, total: 0 };
    for (const r of rows) {
        counts.total += r.n;
        if (r._id === 'synced') counts.synced = r.n;
        else if (r._id === 'error') counts.error = r.n;
    }
    return counts;
}

/**
 * Removes all map rows for a connection (called on hard disconnect so a later reinstall
 * re-matches against whatever the store looks like then).
 * @param {ObjectId|string} connectionId
 */
async function deleteForConnection(connectionId) {
    await getDb().collection(COLLECTION_NAME).deleteMany({ connectionId: toObjectId(connectionId) });
}

/**
 * Tombstones map rows for products that were DELETED in the store but belong to a
 * `create_then_handoff` source — the merchant chose to remove the listing, so we must NOT
 * silently recreate it on the next sync (that would undo the "handoff"). The row is kept (not
 * dropped) with `state: 'deleted_in_store'` so the sync engine skips it for push/match/create and
 * the UI can surface it as a warning with a "Recreate on next sync" action. `recreateRequested`
 * is reset to false — a fresh deletion is never auto-flagged for recreation.
 * @param {ObjectId|string} connectionId
 * @param {string[]} skus
 * @returns {Promise<number>} rows tombstoned
 */
async function markDeletedInStore(connectionId, skus) {
    if (!skus.length) return 0;
    const now = new Date();
    const result = await getDb().collection(COLLECTION_NAME).updateMany(
        { connectionId: toObjectId(connectionId), sku: { $in: skus } },
        { $set: { state: 'deleted_in_store', deletedInStoreAt: now, recreateRequested: false, updatedAt: now } }
    );
    return result.modifiedCount || 0;
}

/**
 * Sets (or clears) the recreate flag on tombstoned rows (whole parent products). The partner
 * clicks "Recreate on next sync" on a removed-in-store product (`requested = true`); the next run
 * drops the flagged rows so they flow back through the normal create path. Passing
 * `requested = false` is the undo — it leaves the product tombstoned (still a warning) but cancels
 * the queued recreation. Only rows already in the `deleted_in_store` state are touched.
 * @param {ObjectId|string} connectionId
 * @param {string[]} parentCodes
 * @param {boolean} [requested=true] - true to queue recreation, false to cancel a queued one
 * @returns {Promise<number>} rows changed
 */
async function requestRecreate(connectionId, parentCodes, requested = true) {
    if (!parentCodes.length) return 0;
    const result = await getDb().collection(COLLECTION_NAME).updateMany(
        { connectionId: toObjectId(connectionId), parentCode: { $in: parentCodes }, state: 'deleted_in_store' },
        { $set: { recreateRequested: requested, updatedAt: new Date() } }
    );
    return result.modifiedCount || 0;
}

/**
 * Lists tombstoned (deleted-in-store) rows for a connection so the UI can warn the partner that
 * a handed-off product was removed in Shopify and offer to recreate it.
 * @param {ObjectId|string} connectionId
 * @returns {Promise<Array<Object>>} the raw tombstone rows
 */
async function getDeletedInStore(connectionId) {
    return getDb()
        .collection(COLLECTION_NAME)
        .find({ connectionId: toObjectId(connectionId), state: 'deleted_in_store' })
        .toArray();
}

/**
 * Removes specific SKUs' map rows for a connection. Used to drop **stale** mappings when a
 * push reports the Shopify variant/inventory item no longer exists (the merchant deleted the
 * product). Dropping the row makes the SKU unmapped again, so the next sync re-matches it
 * (re-creating drift-free) instead of forever pushing to a dead id.
 * @param {ObjectId|string} connectionId
 * @param {string[]} skus
 * @returns {Promise<number>} rows removed
 */
async function deleteBySkus(connectionId, skus) {
    if (!skus.length) return 0;
    const result = await getDb().collection(COLLECTION_NAME).deleteMany({
        connectionId: toObjectId(connectionId),
        sku: { $in: skus }
    });
    return result.deletedCount || 0;
}

module.exports = {
    COLLECTION_NAME,
    getMapBySku,
    bulkUpsertMatches,
    bulkSetState,
    bulkSetHashes,
    getStateCounts,
    markDeletedInStore,
    requestRecreate,
    getDeletedInStore,
    deleteForConnection,
    deleteBySkus
};
