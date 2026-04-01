const { getDb } = require('../services/db/mongo.service');
const { ObjectId } = require('mongodb');

const getAllCategories = async () => {
    const db = getDb();
    return db.collection('categories').find({}).toArray();
};

const getCategoriesByExportId = async (exportId) => {
    const db = getDb();
    return db.collection('categories').find({ exportId }).sort({ label: 1 }).toArray();
};

const createCategory = async (exportId, label) => {
    const db = getDb();
    const doc = { exportId, label };
    const result = await db.collection('categories').insertOne(doc);
    return { _id: result.insertedId, ...doc };
};

const createManyCategories = async (items) => {
    const db = getDb();
    if (!items.length) return 0;
    const result = await db.collection('categories').insertMany(items);
    return result.insertedCount;
};

const updateCategory = async (id, label) => {
    const db = getDb();
    if (!ObjectId.isValid(id)) return null;
    return db.collection('categories').findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { label } },
        { returnDocument: 'after' }
    );
};

const deleteCategory = async (id) => {
    const db = getDb();
    if (!ObjectId.isValid(id)) return 0;
    const result = await db.collection('categories').deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount;
};

const deleteCategoriesByExportId = async (exportId) => {
    const db = getDb();
    const result = await db.collection('categories').deleteMany({ exportId });
    return result.deletedCount;
};

module.exports = {
    getAllCategories,
    getCategoriesByExportId,
    createCategory,
    createManyCategories,
    updateCategory,
    deleteCategory,
    deleteCategoriesByExportId,
};
