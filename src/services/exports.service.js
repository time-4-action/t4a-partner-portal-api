const { getDb } = require('../services/db/mongo.service');
const { ObjectId } = require('mongodb');

/**
 * Retrieves all documents from the 'exports' collection.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of export documents.
 */
const getAllExports = async () => {
    const db = getDb();
    // This assumes you have a collection named 'exports'.
    return db.collection('exports').find({}).toArray();
};

/**
 * Retrieves all documents from the 'exports' collection where AI categorization is enabled.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of export documents.
 */
const getAiEnabledExports = async () => {
    const db = getDb();
    // Find all exports that are enabled for AI categorization.
    return db.collection('exports').find({ aiCategorizationEnabled: true }).toArray();
};

/**
 * Retrieves an export document by its ID.
 * @param {string} id - The ID of the export document to retrieve.
 * @returns {Promise<Object|null>} A promise that resolves to the export document, or null if not found.
 */
const getExportById = async (id) => {
    const db = getDb();
    // Ensure the ID is a valid ObjectId before querying
    if (!ObjectId.isValid(id)) {
        console.warn(`Invalid ID format for getExportById: ${id}`);
        return null;
    }
    return db.collection('exports').findOne({ _id: new ObjectId(id) });
};

const createExport = async (fields) => {
    const db = getDb();
    const doc = {
        name: fields.name,
        description: fields.description ?? '',
        aiCategorizationEnabled: fields.aiCategorizationEnabled ?? false,
        roles: fields.roles ?? [],
        users: fields.users ?? [],
    };
    const result = await db.collection('exports').insertOne(doc);
    return { _id: result.insertedId, ...doc };
};

const updateExport = async (id, fields) => {
    const db = getDb();
    if (!ObjectId.isValid(id)) return null;
    const $set = {};
    if (fields.name !== undefined) $set.name = fields.name;
    if (fields.description !== undefined) $set.description = fields.description;
    if (fields.aiCategorizationEnabled !== undefined) $set.aiCategorizationEnabled = fields.aiCategorizationEnabled;
    if (fields.roles !== undefined) $set.roles = fields.roles;
    if (fields.users !== undefined) $set.users = fields.users;
    return db.collection('exports').findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set },
        { returnDocument: 'after' }
    );
};

const deleteExport = async (id) => {
    const db = getDb();
    if (!ObjectId.isValid(id)) return 0;
    const result = await db.collection('exports').deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount;
};

module.exports = { getAllExports, getAiEnabledExports, getExportById, createExport, updateExport, deleteExport };
