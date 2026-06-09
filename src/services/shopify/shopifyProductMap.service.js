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
    deleteForConnection,
    deleteBySkus
};
