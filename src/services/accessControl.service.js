const { getDb } = require('./db/mongo.service');
const { ObjectId } = require('mongodb');

const COLLECTION_NAME = 'export_configs';

/**
 * Grants access to an export for a grantee email.
 * The grantee's Auth0 sub is filled lazily on first access.
 */
const grantAccess = async (exportId, granteeEmail, grantorSub) => {
    if (!ObjectId.isValid(exportId)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    // Check if already granted
    const existing = await collection.findOne({
        _id: new ObjectId(exportId),
        'accessList.email': granteeEmail
    });

    if (existing) {
        const error = new Error('Access already granted to this user');
        error.code = 'DUPLICATE_ACCESS';
        throw error;
    }

    const entry = {
        email: granteeEmail,
        sub: null,
        grantedAt: new Date(),
        grantedBy: grantorSub
    };

    const result = await collection.updateOne(
        { _id: new ObjectId(exportId) },
        { $push: { accessList: entry } }
    );

    if (result.matchedCount === 0) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    return entry;
};

/**
 * Revokes access for a grantee email.
 */
const revokeAccess = async (exportId, granteeEmail) => {
    if (!ObjectId.isValid(exportId)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const result = await collection.updateOne(
        { _id: new ObjectId(exportId) },
        { $pull: { accessList: { email: granteeEmail } } }
    );

    if (result.matchedCount === 0) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    return true;
};

/**
 * Lists all access entries for an export.
 */
const listAccess = async (exportId) => {
    if (!ObjectId.isValid(exportId)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const config = await collection.findOne(
        { _id: new ObjectId(exportId) },
        { projection: { accessList: 1 } }
    );

    if (!config) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    return config.accessList || [];
};

module.exports = { grantAccess, revokeAccess, listAccess };
