const crypto = require('crypto');
const { getDb } = require('./db/mongo.service');
const { ObjectId } = require('mongodb');

const COLLECTION_NAME = 'export_configs';

/**
 * Creates a new API key for an export configuration.
 * Returns the raw key once — it is not stored, only its SHA-256 hash is.
 */
const createApiKey = async (exportId, keyName, createdBySub) => {
    if (!ObjectId.isValid(exportId)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const exportShort = exportId.slice(0, 6);
    const randomHex = crypto.randomBytes(32).toString('hex');
    const rawKey = `pk_${exportShort}_${randomHex}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 16);
    const keyId = crypto.randomUUID();

    const now = new Date();
    const keyRecord = {
        keyId,
        name: keyName || 'API Key',
        keyHash,
        keyPrefix,
        createdAt: now,
        createdBy: createdBySub,
        lastUsedAt: null,
        isActive: true
    };

    const result = await collection.updateOne(
        { _id: new ObjectId(exportId) },
        { $push: { apiKeys: keyRecord } }
    );

    if (result.matchedCount === 0) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    // Return record without hash, plus the raw key (shown once only)
    const { keyHash: _omit, ...safeRecord } = keyRecord;
    return { rawKey, keyRecord: safeRecord };
};

/**
 * Revokes (soft-deletes) an API key by setting isActive to false.
 */
const revokeApiKey = async (exportId, keyId) => {
    if (!ObjectId.isValid(exportId)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const result = await collection.updateOne(
        { _id: new ObjectId(exportId), 'apiKeys.keyId': keyId },
        { $set: { 'apiKeys.$.isActive': false } }
    );

    if (result.matchedCount === 0) {
        const error = new Error('API key not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    return true;
};

/**
 * Lists all API keys for an export, excluding keyHash.
 */
const listApiKeys = async (exportId) => {
    if (!ObjectId.isValid(exportId)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const config = await collection.findOne(
        { _id: new ObjectId(exportId) },
        { projection: { apiKeys: 1 } }
    );

    if (!config) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    return (config.apiKeys || []).map(({ keyHash: _omit, ...rest }) => rest);
};

/**
 * Verifies a raw API key.
 * Updates lastUsedAt as a fire-and-forget side effect.
 * Returns { exportConfig, keyId } or null if invalid.
 */
const verifyApiKey = async (rawKey) => {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const exportConfig = await collection.findOne({
        'apiKeys': { $elemMatch: { keyHash, isActive: true } }
    });

    if (!exportConfig) return null;

    const keyRecord = exportConfig.apiKeys.find(k => k.keyHash === keyHash && k.isActive);
    if (!keyRecord) return null;

    // Fire-and-forget: update lastUsedAt
    collection.updateOne(
        { _id: exportConfig._id, 'apiKeys.keyId': keyRecord.keyId },
        { $set: { 'apiKeys.$.lastUsedAt': new Date() } }
    ).catch(() => {});

    return { exportConfig, keyId: keyRecord.keyId };
};

module.exports = { createApiKey, revokeApiKey, listApiKeys, verifyApiKey };
