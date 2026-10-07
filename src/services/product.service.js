const { getDb } = require('./db/mongo.service');
const { ObjectId } = require('mongodb');

/**
 * Fetches all products from the database.
 * @param {Object} [options]
 * @param {boolean} [options.publishedOnly=false] - When true, only published &
 *   active parents are returned, and each parent's `child_products` is narrowed
 *   to its published variants (mirrors `applyFilters` in customExport.service.js,
 *   which always enforces published-only so unannounced products never leak).
 * @returns {Promise<Array<Object>>} A promise that resolves with an array of product documents.
 */
const getAllProducts = async ({ publishedOnly = false } = {}) => {
    try {
        const db = getDb();
        const query = publishedOnly ? { active: { $ne: false }, published: true } : {};
        const products = await db.collection('products').find(query).toArray();
        if (!publishedOnly) return products;
        // Drop unpublished variants so a published parent never exposes them.
        return products.map(p => ({
            ...p,
            child_products: (p.child_products || []).filter(v => v.published),
        }));
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
 * @param {Object} [options]
 * @param {boolean} [options.publishedOnly=false] - When true, only a published &
 *   active parent is returned, and its `child_products` is narrowed to published
 *   variants (mirrors `getAllProducts` so the detail view never exposes an
 *   unpublished parent or unpublished sub-variants).
 * @returns {Promise<Object|null>} A promise that resolves with the product document or null if not found.
 */
const getProductByIdentifier = async (identifier, { publishedOnly = false } = {}) => {
    try {
        const db = getDb();

        // Use $or to find a match in any of the relevant fields
        const match = {
            $or: [
                { code: identifier },
                { token: identifier },
                { "child_products.code": identifier },
                { "child_products.token": identifier }
            ]
        };
        const query = publishedOnly
            ? { active: { $ne: false }, published: true, ...match }
            : match;
        const product = await db.collection('products').findOne(query);
        if (!product || !publishedOnly) return product;
        // Drop unpublished variants so a published parent never exposes them.
        return {
            ...product,
            child_products: (product.child_products || []).filter(v => v.published),
        };
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

/**
 * Products governed by a category set, for the Categories page review table. This spans BOTH
 * catalogues: Patrik's shared `products` and the `external_products` rows of every Own Source
 * feed that has AI categorization switched ON for this set (plus any feed row still carrying a
 * category for it, so a feed you just switched off stays reviewable until its categories are
 * cleared). Switching a feed on in its settings is what makes its products appear here.
 *
 * Each row carries `sourceType`/`sourceName` so the UI can label where a product came from.
 */
const getProductsWithAiCategoriesForExport = async (exportId) => {
    const db = getDb();
    const projection = { _id: 1, code: 1, token: 1, product_name: 1, ai_categories: 1 };

    const { listFeedIdsForAiExport } = require('./external/ownSource.service');
    const feedIds = await listFeedIdsForAiExport(exportId);

    const [products, externals] = await Promise.all([
        db.collection('products')
            .find({ active: { $ne: false } }, { projection })
            .sort({ product_name: 1 })
            .toArray(),
        db.collection('external_products')
            .find(
                {
                    active: { $ne: false },
                    $or: [
                        ...(feedIds.length ? [{ feedId: { $in: feedIds } }] : []),
                        { 'ai_categories.exportId': exportId }
                    ]
                },
                { projection: { ...projection, feedId: 1, vendor: 1 } }
            )
            .sort({ product_name: 1 })
            .toArray()
    ]);

    const shape = (p, sourceType, sourceName) => ({
        _id: p._id,
        code: p.code,
        token: p.token,
        product_name: p.product_name,
        sourceType,
        sourceName,
        aiCategory: p.ai_categories?.find(c => c.exportId === exportId) ?? null,
    });

    return [
        ...products.map(p => shape(p, 'patrik', 'Patrik')),
        ...externals.map(p => shape(p, 'own_source', p.vendor || p.feedId)),
    ];
};

/**
 * Resolves which collection an AI-category product id lives in. Ids are ObjectIds unique to their
 * collection, so "look in `products`, else `external_products`" is unambiguous and keeps the
 * Categories page from having to know where a row came from.
 */
const _aiCategoryCollection = async (productId) => {
    const db = getDb();
    const _id = new ObjectId(productId);
    if (await db.collection('products').countDocuments({ _id }, { limit: 1 })) {
        return db.collection('products');
    }
    if (await db.collection('external_products').countDocuments({ _id }, { limit: 1 })) {
        return db.collection('external_products');
    }
    return null;
};

const setProductAiCategory = async (productId, exportId, categoryId, categoryName) => {
    if (!ObjectId.isValid(productId)) return null;
    const col = await _aiCategoryCollection(productId);
    if (!col) return null;
    await col.updateOne(
        { _id: new ObjectId(productId) },
        { $pull: { ai_categories: { exportId } } }
    );
    return col.findOneAndUpdate(
        { _id: new ObjectId(productId) },
        // `manual: true` marks the partner's own choice — the feed categorizer treats such an
        // entry as final and never re-categorizes over it, even when the supplier's content changes.
        { $push: { ai_categories: { exportId, categoryId, categoryName, manual: true, at: new Date() } } },
        { returnDocument: 'after', projection: { _id: 1, code: 1, ai_categories: 1 } }
    );
};

const removeProductAiCategory = async (productId, exportId) => {
    if (!ObjectId.isValid(productId)) return null;
    const col = await _aiCategoryCollection(productId);
    if (!col) return null;
    return col.findOneAndUpdate(
        { _id: new ObjectId(productId) },
        { $pull: { ai_categories: { exportId } } },
        { returnDocument: 'after', projection: { _id: 1, code: 1, ai_categories: 1 } }
    );
};

const clearAllAiCategoriesForExport = async (exportId) => {
    const db = getDb();
    const filter = { 'ai_categories.exportId': exportId };
    const update = { $pull: { ai_categories: { exportId } } };
    const [patrik, external] = await Promise.all([
        db.collection('products').updateMany(filter, update),
        db.collection('external_products').updateMany(filter, update),
    ]);
    return (patrik.modifiedCount || 0) + (external.modifiedCount || 0);
};

const _resolveCategory = (parent, exportId) => {
    if (!exportId) return undefined;
    const match = (parent.ai_categories || []).find((c) => c.exportId === exportId);
    return match ? match.categoryName : null;
};

const _formatParent = (p, category) => ({
    code: p.code,
    ean_code: p.ean_code || '',
    product_name: p.product_name,
    image: (p.images && p.images[0]) || null,
    ...(category !== undefined && { category }),
});

const _formatChild = (c, category) => ({
    code: c.code,
    ean_code: c.ean_code || '',
    product_name: c.product_name,
    image: (c.images && c.images[0]) || null,
    ...(category !== undefined && { category }),
});

const _allWordsMatch = (text, wordRegs) => wordRegs.every((r) => r.test(text || ''));

/**
 * @param {string} query
 * @param {string|null} [exportId]
 * @param {Object} [options]
 * @param {boolean} [options.includeUnpublished=false] - When true (trusted
 *   x-api-key callers), search the full catalogue including unpublished /
 *   inactive parents and variants. Default keeps the public published-only view.
 */
const searchProducts = async (query, exportId = null, { includeUnpublished = false } = {}) => {
    const db = getDb();
    const collection = db.collection('products');
    const activeFilter = includeUnpublished ? {} : { active: { $ne: false }, published: true };
    // Trusted callers see every variant; public callers only published ones.
    const childVisible = (c) => includeUnpublished || c.published;

    // Exact code/EAN match → single result
    const exactParent = await collection.findOne({ ...activeFilter, $or: [{ code: query }, { ean_code: query }] });
    if (exactParent) return [_formatParent(exactParent, _resolveCategory(exactParent, exportId))];

    const exactChildParent = await collection.findOne({
        ...activeFilter,
        $or: [{ 'child_products.code': query }, { 'child_products.ean_code': query }],
    });
    if (exactChildParent) {
        const child = exactChildParent.child_products.find(
            (c) => (c.code === query || c.ean_code === query) && childVisible(c),
        );
        if (child) return [_formatChild(child, _resolveCategory(exactChildParent, exportId))];
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
        const category = _resolveCategory(parent, exportId);
        const visibleChildren = (parent.child_products || []).filter(childVisible);

        if (visibleChildren.length === 0) {
            results.push(_formatParent(parent, category));
            continue;
        }

        const parentCodeMatch = codeRegex.test(parent.code) || codeRegex.test(parent.ean_code || '');
        const parentNameMatch = _allWordsMatch(parent.product_name, wordRegs);

        if (parentCodeMatch || parentNameMatch) {
            // Parent matched by code/name — return all visible children as variants
            for (const child of visibleChildren) {
                results.push(_formatChild(child, category));
            }
        } else {
            // Only specific children matched — return just those (visible only)
            for (const child of visibleChildren) {
                if (
                    codeRegex.test(child.code || '') ||
                    codeRegex.test(child.ean_code || '') ||
                    _allWordsMatch(child.product_name, wordRegs)
                ) {
                    results.push(_formatChild(child, category));
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