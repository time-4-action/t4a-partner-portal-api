const crypto = require('crypto');
const { getDb } = require('../db/mongo.service');
const { ObjectId } = require('mongodb');
const { COLLECTION_NAME } = require('./shopifyConnection.service');

/**
 * API keys for the Sources API (`docs/sources-api.md`) — one or more per **connected store**.
 *
 * A key lets an external client (Recharge Hub, today) read and change the sources of ONE
 * connection and start its runs. It is bound to that connection, and through it to one shop
 * domain: the middleware refuses a key presented for another shop, which is what stops a pasted
 * key from configuring another partner's store. Same storage discipline as the export-config keys
 * (`apiKey.service.js`): the raw key is returned once, only its SHA-256 hash is kept, and a revoke
 * is a soft flag so the audit of "which key did that" survives.
 *
 * Keys live embedded on the connection document (`apiKeys[]`) so they go away with it — a portal
 * disconnect, an uninstall+redact, or a deleted connection leaves no orphan credential behind.
 */

const KEY_PREFIX = 'sk_t4a_';

function hashKey(rawKey) {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function notFound(message) {
    return Object.assign(new Error(message), { code: 'NOT_FOUND' });
}

/**
 * Mints a key for a connection. Returns `{ rawKey, keyRecord }`; the raw key is shown once.
 * @param {string} connectionId
 * @param {string} [name]
 * @param {string|null} [createdBySub]
 */
async function createConnectionApiKey(connectionId, name, createdBySub = null) {
    if (!ObjectId.isValid(connectionId)) throw Object.assign(new Error('Invalid connection id'), { code: 'INVALID_ID' });
    const rawKey = `${KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
    const now = new Date();
    const keyRecord = {
        keyId: crypto.randomUUID(),
        name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 60) : 'API key',
        keyHash: hashKey(rawKey),
        // Enough to recognise a key in a list, never enough to use it.
        keyPrefix: rawKey.slice(0, KEY_PREFIX.length + 6),
        last4: rawKey.slice(-4),
        createdAt: now,
        createdBy: createdBySub,
        lastUsedAt: null,
        revokedAt: null,
        isActive: true
    };
    const result = await getDb().collection(COLLECTION_NAME).updateOne(
        { _id: new ObjectId(connectionId) },
        { $push: { apiKeys: keyRecord } }
    );
    if (result.matchedCount === 0) throw notFound('Connection not found');
    const { keyHash: _omit, ...safe } = keyRecord;
    return { rawKey, keyRecord: safe };
}

/** Lists a connection's keys without their hashes, newest first. */
async function listConnectionApiKeys(connectionId) {
    if (!ObjectId.isValid(connectionId)) throw Object.assign(new Error('Invalid connection id'), { code: 'INVALID_ID' });
    const conn = await getDb().collection(COLLECTION_NAME).findOne(
        { _id: new ObjectId(connectionId) },
        { projection: { apiKeys: 1 } }
    );
    if (!conn) throw notFound('Connection not found');
    return (conn.apiKeys || [])
        .map(({ keyHash: _omit, ...rest }) => rest)
        .sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0));
}

/** Revokes a key. A revoked key is refused from the next request on; the record stays. */
async function revokeConnectionApiKey(connectionId, keyId) {
    if (!ObjectId.isValid(connectionId)) throw Object.assign(new Error('Invalid connection id'), { code: 'INVALID_ID' });
    const result = await getDb().collection(COLLECTION_NAME).updateOne(
        { _id: new ObjectId(connectionId), 'apiKeys.keyId': keyId },
        { $set: { 'apiKeys.$.isActive': false, 'apiKeys.$.revokedAt': new Date() } }
    );
    if (result.matchedCount === 0) throw notFound('API key not found');
    return true;
}

/**
 * Resolves a raw key to its connection. Returns `{ connection, keyRecord }` — the RAW connection
 * document (with encrypted tokens), for the API layer to shape — or null when the key is unknown or
 * revoked. Touches `lastUsedAt` fire-and-forget.
 */
async function verifyConnectionApiKey(rawKey) {
    if (typeof rawKey !== 'string' || !rawKey.startsWith(KEY_PREFIX)) return null;
    const keyHash = hashKey(rawKey);
    const collection = getDb().collection(COLLECTION_NAME);
    const connection = await collection.findOne({ apiKeys: { $elemMatch: { keyHash, isActive: true } } });
    if (!connection) return null;
    const keyRecord = connection.apiKeys.find((k) => k.keyHash === keyHash && k.isActive);
    if (!keyRecord) return null;
    collection.updateOne(
        { _id: connection._id, 'apiKeys.keyId': keyRecord.keyId },
        { $set: { 'apiKeys.$.lastUsedAt': new Date() } }
    ).catch(() => {});
    const { keyHash: _omit, ...safe } = keyRecord;
    return { connection, keyRecord: safe };
}

module.exports = {
    KEY_PREFIX,
    createConnectionApiKey,
    listConnectionApiKeys,
    revokeConnectionApiKey,
    verifyConnectionApiKey
};
