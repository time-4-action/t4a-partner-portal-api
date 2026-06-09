const { getDb } = require('../db/mongo.service');
const { ObjectId } = require('mongodb');
const { encryptToken } = require('./crypto.service');

/**
 * Data-access layer for the `shopify_connections` collection — one document per
 * connected store (design §6). Access tokens are stored encrypted; this module
 * never returns the plaintext or the encrypted token to callers other than the
 * sync engine via {@link getConnectionWithToken}.
 */

const COLLECTION_NAME = 'shopify_connections';

const DEFAULT_SCOPES = (process.env.SHOPIFY_SCOPES ||
    'read_products,write_products,read_inventory,write_inventory,read_locations')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Default per-connection sync config — safe defaults: stock-only, no image push. */
const DEFAULT_CONFIG = {
    exportConfigId: null,
    pricelistPriority: [],
    priceVatMode: 'inclusive', // 'inclusive' | 'exclusive'
    futureDatedGuard: true,
    syncStock: true,
    syncNewProducts: false,
    syncPrices: false,
    syncDescriptions: false,
    syncImages: false,
    ownership: 'stock_only' // 'stock_only' | 'portal_authoritative' | 'create_then_handoff'
};

/**
 * Strips secrets (encrypted token) before a connection leaves the service for the API layer.
 */
function toPublic(conn) {
    if (!conn) return null;
    const { accessTokenEnc, ...rest } = conn;
    return { ...rest, _id: conn._id.toString(), connected: conn.status === 'active' };
}

/**
 * Upserts a connection after a successful OAuth exchange. Keyed by (ownerSub, shopDomain)
 * so re-installing the same store for the same user refreshes the token in place rather than
 * duplicating. Preserves an existing `config` on re-install.
 * @returns {Promise<Object>} the public-shaped connection
 */
async function upsertConnection({ ownerSub, ownerEmail, shopDomain, accessToken, scopes, shopInfo }) {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const now = new Date();

    const existing = await collection.findOne({ ownerSub, shopDomain });

    const setFields = {
        ownerSub,
        ownerEmail: ownerEmail || null,
        shopDomain,
        accessTokenEnc: encryptToken(accessToken),
        scopes: scopes && scopes.length ? scopes : DEFAULT_SCOPES,
        shopName: shopInfo?.name || existing?.shopName || null,
        shopCurrency: shopInfo?.currency || existing?.shopCurrency || null,
        status: 'active',
        updatedAt: now
    };

    if (existing) {
        await collection.updateOne({ _id: existing._id }, { $set: setFields });
        return toPublic({ ...existing, ...setFields });
    }

    const doc = {
        ...setFields,
        shopifyLocationId: null,
        config: { ...DEFAULT_CONFIG },
        installedAt: now,
        lastSyncAt: null,
        lastSyncStatus: null
    };
    const result = await collection.insertOne(doc);
    return toPublic({ ...doc, _id: result.insertedId });
}

/**
 * Returns the connection for a portal user (by Auth0 sub), public-shaped, or null.
 * A user has at most one active store in this first cut; returns the most recently updated.
 */
async function getConnectionForUser(ownerSub) {
    const db = getDb();
    const conn = await db
        .collection(COLLECTION_NAME)
        .findOne({ ownerSub, status: { $ne: 'uninstalled' } }, { sort: { updatedAt: -1 } });
    return toPublic(conn);
}

/**
 * Returns a connection by id, public-shaped, or null.
 */
async function getConnectionById(id) {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid connection id');
        error.code = 'INVALID_ID';
        throw error;
    }
    const db = getDb();
    const conn = await db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(id) });
    return toPublic(conn);
}

/**
 * Returns the raw connection INCLUDING the encrypted token. For internal use by the
 * sync engine and the OAuth/locations flow — never expose the result over the API.
 */
async function getConnectionWithToken(id) {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid connection id');
        error.code = 'INVALID_ID';
        throw error;
    }
    const db = getDb();
    return db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(id) });
}

/**
 * Updates the per-connection sync config and/or chosen Shopify location.
 * Only whitelisted keys are accepted. Returns the public-shaped connection.
 */
async function updateConnectionConfig(id, patch) {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid connection id');
        error.code = 'INVALID_ID';
        throw error;
    }
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const allowed = [
        'exportConfigId', 'pricelistPriority', 'priceVatMode', 'futureDatedGuard',
        'syncStock', 'syncNewProducts', 'syncPrices', 'syncDescriptions', 'syncImages', 'ownership'
    ];
    const set = { updatedAt: new Date() };
    if (patch.config) {
        for (const key of allowed) {
            if (key in patch.config) set[`config.${key}`] = patch.config[key];
        }
    }
    if ('shopifyLocationId' in patch) set.shopifyLocationId = patch.shopifyLocationId;

    const result = await collection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: set },
        { returnDocument: 'after' }
    );
    const updated = result.value || result; // driver compat
    if (!updated) {
        const error = new Error('Connection not found');
        error.code = 'NOT_FOUND';
        throw error;
    }
    return toPublic(updated);
}

/**
 * Sets the connection status (e.g. 'uninstalled' on app/uninstalled webhook, 'error' on failure).
 */
async function setStatus(id, status, extra = {}) {
    if (!ObjectId.isValid(id)) return;
    const db = getDb();
    await db.collection(COLLECTION_NAME).updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updatedAt: new Date(), ...extra } }
    );
}

/**
 * Marks every connection for a shop domain as uninstalled (app/uninstalled webhook).
 * The map/token are kept for a possible reinstall but the token is cleared to be safe.
 */
async function markUninstalledByShop(shopDomain) {
    const db = getDb();
    await db.collection(COLLECTION_NAME).updateMany(
        { shopDomain },
        { $set: { status: 'uninstalled', accessTokenEnc: null, updatedAt: new Date() } }
    );
}

/**
 * Hard-deletes a connection (explicit user disconnect). Returns true if removed.
 */
async function deleteConnection(id) {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid connection id');
        error.code = 'INVALID_ID';
        throw error;
    }
    const db = getDb();
    const result = await db.collection(COLLECTION_NAME).deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount > 0;
}

/**
 * Creates indexes for the connection + map + job collections. Called once at startup.
 */
async function ensureIndexes() {
    try {
        const db = getDb();
        await db.collection(COLLECTION_NAME).createIndex({ ownerSub: 1, shopDomain: 1 }, { unique: true });
        await db.collection(COLLECTION_NAME).createIndex({ shopDomain: 1 });
        await db.collection(COLLECTION_NAME).createIndex({ status: 1 });

        // Forward-declared collections for the sync engine (design §6) — index now so the
        // data plane can be added later without a migration.
        await db.collection('shopify_product_map').createIndex({ connectionId: 1, sku: 1 });
        await db.collection('shopify_product_map').createIndex({ connectionId: 1, parentCode: 1 });
        await db.collection('shopify_sync_jobs').createIndex({ connectionId: 1, status: 1 });
        await db.collection('shopify_sync_jobs').createIndex({ nextAttemptAt: 1 }, { sparse: true });

        console.log('[shopify] Connection indexes ensured.');
    } catch (error) {
        console.error('[shopify] Index creation error:', error.message);
    }
}

module.exports = {
    COLLECTION_NAME,
    DEFAULT_SCOPES,
    DEFAULT_CONFIG,
    upsertConnection,
    getConnectionForUser,
    getConnectionById,
    getConnectionWithToken,
    updateConnectionConfig,
    setStatus,
    markUninstalledByShop,
    deleteConnection,
    ensureIndexes
};
