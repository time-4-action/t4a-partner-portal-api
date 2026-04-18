const { getDb } = require('./db/mongo.service');
const { ObjectId } = require('mongodb');

/**
 * Fetches all products from the database.
 * @returns {Promise<Array<Object>>} A promise that resolves with an array of product documents.
 */
const getAllProducts = async () => {
    try {
        const db = getDb();
        // Fetches all documents from the 'products' collection.
        return await db.collection('products').find({}).toArray();
    } catch (error) {
        console.error('Error fetching products from database:', error);
        throw new Error('Product data is not available.');
    }
};

/**
 * Fetches a single product from the database by its code or token.
 * This function searches for the identifier in the main product's `code` and `token` fields,
 * as well as in the `code` and `token` fields of any child products.
 * @param {string} identifier - The code or token of the product to find.
 * @returns {Promise<Object|null>} A promise that resolves with the product document or null if not found.
 */
const getProductByIdentifier = async (identifier) => {
    try {
        const db = getDb();

        // Use $or to find a match in any of the relevant fields
        const product = await db.collection('products').findOne({
            $or: [
                { code: identifier },
                { token: identifier },
                { "child_products.code": identifier },
                { "child_products.token": identifier }
            ]
        });
        return product;
    } catch (error) {
        console.error(`Error fetching product with identifier ${identifier} from database:`, error);
        throw new Error(`An error occurred while fetching product with identifier ${identifier}.`);
    }
};
/**
 * Generates a TSV string from the products data.
 * @param {string} exportId - The export identifier to get the category for (e.g., 'tris').
 * @returns {Promise<string>} A promise that resolves with the TSV content.
 */
const generateProductsTsv = async (exportId) => {
    if (!exportId) {
        throw new Error('exportId is required to generate the TSV.');
    }
    const products = await getAllProducts();
    const header = 'Naziv\tKategorija\n';
    const tsvRows = products.map(p => {
        // Find the category that matches the requested exportId
        const categoryInfo = p.ai_categories?.find(cat => cat.exportId === exportId);
        const categoryName = categoryInfo ? categoryInfo.categoryName : '';
        return `${p.product_name}\t${categoryName}`;
    });
    return header + tsvRows.join('\n');
};

const getProductsWithAiCategoriesForExport = async (exportId) => {
    const db = getDb();
    const products = await db.collection('products')
        .find(
            { active: { $ne: false } },
            { projection: { _id: 1, code: 1, token: 1, product_name: 1, ai_categories: 1 } }
        )
        .sort({ product_name: 1 })
        .toArray();

    return products.map(p => {
        const match = p.ai_categories?.find(c => c.exportId === exportId) ?? null;
        return {
            _id: p._id,
            code: p.code,
            token: p.token,
            product_name: p.product_name,
            aiCategory: match,
        };
    });
};

const setProductAiCategory = async (productId, exportId, categoryId, categoryName) => {
    const db = getDb();
    if (!ObjectId.isValid(productId)) return null;
    const col = db.collection('products');
    await col.updateOne(
        { _id: new ObjectId(productId) },
        { $pull: { ai_categories: { exportId } } }
    );
    return col.findOneAndUpdate(
        { _id: new ObjectId(productId) },
        { $push: { ai_categories: { exportId, categoryId, categoryName } } },
        { returnDocument: 'after', projection: { _id: 1, code: 1, ai_categories: 1 } }
    );
};

const removeProductAiCategory = async (productId, exportId) => {
    const db = getDb();
    if (!ObjectId.isValid(productId)) return null;
    return db.collection('products').findOneAndUpdate(
        { _id: new ObjectId(productId) },
        { $pull: { ai_categories: { exportId } } },
        { returnDocument: 'after', projection: { _id: 1, code: 1, ai_categories: 1 } }
    );
};

const clearAllAiCategoriesForExport = async (exportId) => {
    const db = getDb();
    const result = await db.collection('products').updateMany(
        { 'ai_categories.exportId': exportId },
        { $pull: { ai_categories: { exportId } } }
    );
    return result.modifiedCount;
};

const searchProducts = async (query) => {
    const db = getDb();
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const filter = {
        active: { $ne: false },
        $or: [
            { code: regex },
            { ean_code: regex },
            { product_name: regex },
            { short_description: regex },
            { detailed_description: regex },
            { 'child_products.code': regex },
            { 'child_products.ean_code': regex },
            { 'child_products.product_name': regex },
        ],
    };

    const parents = await db.collection('products').find(filter).toArray();

    const results = [];
    for (const parent of parents) {
        if (parent.child_products && parent.child_products.length > 0) {
            for (const child of parent.child_products) {
                results.push({
                    code: child.code,
                    ean_code: child.ean_code || '',
                    product_name: child.product_name,
                    short_description: child.short_description || parent.short_description || '',
                    detailed_description: child.detailed_description || parent.detailed_description || '',
                    stock_amount: child.stock_amount || 0,
                    image: (child.images && child.images[0]) || (parent.images && parent.images[0]) || null,
                });
            }
        } else {
            results.push({
                code: parent.code,
                ean_code: parent.ean_code || '',
                product_name: parent.product_name,
                short_description: parent.short_description || '',
                detailed_description: parent.detailed_description || '',
                stock_amount: parent.stock_amount || 0,
                image: (parent.images && parent.images[0]) || null,
            });
        }
    }

    return results;
};

module.exports = {
    getAllProducts,
    getProductByIdentifier,
    generateProductsTsv,
    getProductsWithAiCategoriesForExport,
    setProductAiCategory,
    removeProductAiCategory,
    clearAllAiCategoriesForExport,
    searchProducts,
};