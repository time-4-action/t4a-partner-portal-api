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

const _formatParent = (p) => ({
    code: p.code,
    ean_code: p.ean_code || '',
    product_name: p.product_name,
    image: (p.images && p.images[0]) || null,
});

const _formatChild = (c) => ({
    code: c.code,
    ean_code: c.ean_code || '',
    product_name: c.product_name,
    image: (c.images && c.images[0]) || null,
});

const _allWordsMatch = (text, wordRegs) => wordRegs.every((r) => r.test(text || ''));

const searchProducts = async (query) => {
    const db = getDb();
    const collection = db.collection('products');
    const activeFilter = { active: { $ne: false } };

    // Exact code/EAN match → single result
    const exactParent = await collection.findOne({ ...activeFilter, $or: [{ code: query }, { ean_code: query }] });
    if (exactParent) return [_formatParent(exactParent)];

    const exactChildParent = await collection.findOne({
        ...activeFilter,
        $or: [{ 'child_products.code': query }, { 'child_products.ean_code': query }],
    });
    if (exactChildParent) {
        const child = exactChildParent.child_products.find((c) => c.code === query || c.ean_code === query);
        if (child) return [_formatChild(child)];
    }

    // Text search on name/code/ean only (no descriptions — they cause false positives)
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const words = query.trim().split(/\s+/);
    const wordRegs = words.map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const codeRegex = new RegExp(escaped, 'i');

    const nameCondition =
        words.length > 1
            ? { $and: wordRegs.map((r) => ({ product_name: r })) }
            : { product_name: wordRegs[0] };
    const childNameCondition =
        words.length > 1
            ? { $and: wordRegs.map((r) => ({ 'child_products.product_name': r })) }
            : { 'child_products.product_name': wordRegs[0] };

    const filter = {
        ...activeFilter,
        $or: [
            { code: codeRegex },
            { ean_code: codeRegex },
            nameCondition,
            { 'child_products.code': codeRegex },
            { 'child_products.ean_code': codeRegex },
            childNameCondition,
        ],
    };

    const parents = await collection.find(filter).toArray();
    const results = [];

    for (const parent of parents) {
        if (!parent.child_products || parent.child_products.length === 0) {
            results.push(_formatParent(parent));
            continue;
        }

        const parentCodeMatch = codeRegex.test(parent.code) || codeRegex.test(parent.ean_code || '');
        const parentNameMatch = _allWordsMatch(parent.product_name, wordRegs);

        if (parentCodeMatch || parentNameMatch) {
            // Parent matched by code/name — return all children as variants
            for (const child of parent.child_products) {
                results.push(_formatChild(child));
            }
        } else {
            // Only specific children matched — return just those
            for (const child of parent.child_products) {
                if (
                    codeRegex.test(child.code || '') ||
                    codeRegex.test(child.ean_code || '') ||
                    _allWordsMatch(child.product_name, wordRegs)
                ) {
                    results.push(_formatChild(child));
                }
            }
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