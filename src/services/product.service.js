const { getDb } = require('./db/mongo.service');

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

module.exports = { getAllProducts, getProductByIdentifier, generateProductsTsv };