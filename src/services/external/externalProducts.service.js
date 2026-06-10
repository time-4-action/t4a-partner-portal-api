const { getDb } = require('../db/mongo.service');

/**
 * Data-access for the `external_products` collection (design §4.2) — ingested feed products,
 * stored in the INTERNAL `products` shape so the Shopify push reuses everything (buildScope /
 * resolvePushPrice / resolveTagsArray). Physically isolated from Patrik's `products`, so the
 * PNV prune can never touch a feed and dropping a brand is one `deleteMany`.
 *
 * The mapping feed→internal lives in the importer; this module only persists, sweeps and reads.
 */

const COLLECTION_NAME = 'external_products';

/** Upserts each mapped product by `{ feedId, externalId }`, stamping the current importRunId. */
async function bulkUpsert(feedId, ownerSub, importRunId, docs) {
    if (!docs.length) return { created: 0, updated: 0 };
    const db = getDb();
    const ops = docs.map((d) => ({
        updateOne: {
            filter: { feedId, externalId: d.externalId },
            update: {
                $set: { ...d, feedId, ownerSub, importRunId, importedAt: new Date() },
                $setOnInsert: { createdAt: new Date() }
            },
            upsert: true
        }
    }));
    const res = await db.collection(COLLECTION_NAME).bulkWrite(ops, { ordered: false });
    return { created: res.upsertedCount || 0, updated: res.modifiedCount || 0 };
}

/**
 * Applies the feed's removal policy to rows absent from THIS import (importRunId !== current).
 * Returns the number of rows affected (the "removed" count).
 *   - delist     → publish/active off (the next push unpublishes the listing)
 *   - zero_stock → keep listed, set parent + variant stock to 0
 *   - keep       → leave the last-known row untouched
 */
async function sweep(feedId, importRunId, removalPolicy = 'delist') {
    const db = getDb();
    const filter = { feedId, importRunId: { $ne: importRunId } };
    if (removalPolicy === 'keep') return 0;

    if (removalPolicy === 'zero_stock') {
        const res = await db.collection(COLLECTION_NAME).updateMany(filter, [
            { $set: { stock_amount: 0, 'child_products': { $map: { input: '$child_products', as: 'v', in: { $mergeObjects: ['$$v', { stock_amount: 0 }] } } }, importedAt: new Date() } }
        ]);
        return res.modifiedCount || 0;
    }

    // delist (default)
    const res = await db.collection(COLLECTION_NAME).updateMany(filter, [
        { $set: { published: false, active: false, 'child_products': { $map: { input: '$child_products', as: 'v', in: { $mergeObjects: ['$$v', { published: false }] } } }, importedAt: new Date() } }
    ]);
    return res.modifiedCount || 0;
}

/**
 * Returns the published+active rows for a feed in the internal product shape — the input to
 * {@link buildExternalScope}. Variants are NOT narrowed here (the push's item loop handles
 * per-variant publish), but a delisted parent (active:false) is excluded.
 */
async function readPublished(feedId) {
    const db = getDb();
    return db.collection(COLLECTION_NAME)
        .find({ feedId, active: true, published: true })
        .toArray();
}

/** Count of all rows for a feed (used by the wipe-guard ratio check). */
async function countByFeed(feedId) {
    const db = getDb();
    return db.collection(COLLECTION_NAME).countDocuments({ feedId });
}

/**
 * Returns every imported row for a feed in the internal product shape, for the preview drawer.
 * Unlike {@link readPublished} this includes delisted/zero-stock rows so the user sees the full
 * imported catalogue (each row's own `published`/`active` + variant flags say what gets pushed).
 * Capped to keep the response bounded; sorted by name for a stable preview order.
 */
async function listByFeed(feedId, limit = 1000) {
    const db = getDb();
    return db.collection(COLLECTION_NAME)
        .find({ feedId })
        .sort({ product_name: 1 })
        .limit(limit)
        .toArray();
}

/** Removes every product for a feed (called when the feed is deleted). */
async function deleteByFeed(feedId) {
    const db = getDb();
    const res = await db.collection(COLLECTION_NAME).deleteMany({ feedId });
    return res.deletedCount || 0;
}

module.exports = {
    COLLECTION_NAME,
    bulkUpsert,
    sweep,
    readPublished,
    listByFeed,
    countByFeed,
    deleteByFeed
};
