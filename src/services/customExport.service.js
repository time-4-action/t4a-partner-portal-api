const { getDb } = require('./db/mongo.service');
const { ObjectId } = require('mongodb');

const COLLECTION_NAME = 'export_configs';
const PRODUCTS_COLLECTION = 'products';

/**
 * Valid preset types for export configurations
 */
const VALID_PRESETS = ['shopify', 'simple', 'detailed', 'inventory'];

/**
 * Default filter values
 */
const DEFAULT_FILTERS = {
    search: '',
    stockStatus: 'all',
    minPrice: '',
    maxPrice: '',
    category: [],
    aiExportId: 'all',
    aiCategory: [],
    imageFilter: 'all',
    showNew: false,
    showRecommended: false,
    publishedOnly: false
};

/**
 * Field mappings for CSV generation
 */
const FIELD_MAPPINGS = {
    // Shopify fields
    handle: (p, v) => p.token || '',
    title: (p, v) => p.product_name || '',
    body_html: (p, v) => p.detailed_description || p.short_description || '',
    vendor: () => 'Patrik International',
    type: (p, v) => p.categories?.[0] || '',
    tags: (p, v) => [...(p.categories || []), p.new ? 'new' : '', p.recomended ? 'recommended' : ''].filter(Boolean).join(', '),
    published: (p, v) => p.published ? 'TRUE' : 'FALSE',
    variant_sku: (p, v) => v?.code || '',
    variant_title: (p, v) => v?.product_name || '',
    variant_price: (p, v, priceInfo) => priceInfo.price.toFixed(2),
    variant_compare_at_price: (p, v, priceInfo, config) => '',
    variant_inventory_qty: (p, v) => v?.stock_amount || 0,
    variant_barcode: (p, v) => v?.ean_code || '',
    image_src: (p, v, priceInfo, config, image) => image || '',
    image_alt_text: (p, v) => p.product_name || '',
    variant_image: (p, v) => v?.images?.[0] || '',

    // Simple/Detailed fields
    product_name: (p, v) => p.product_name || '',
    variant_name: (p, v) => v?.product_name || '',
    sku: (p, v) => v?.code || '',
    ean: (p, v) => v?.ean_code || '',
    price: (p, v, priceInfo) => priceInfo.price.toFixed(2),
    pricelist_name: (p, v, priceInfo) => priceInfo.name || '',
    vat: (p, v, priceInfo) => priceInfo.vat,
    price_with_vat: (p, v, priceInfo) => (priceInfo.price * (1 + priceInfo.vat / 100)).toFixed(2),
    stock: (p, v) => v?.stock_amount || 0,
    stock_value: (p, v, priceInfo) => ((v?.stock_amount || 0) * priceInfo.price).toFixed(2),
    in_stock: (p, v) => (v?.stock_amount || 0) > 0 ? 'Yes' : 'No',
    categories: (p, v) => (p.categories || []).join('; '),
    short_description: (p, v) => p.short_description || '',
    detailed_description: (p, v) => p.detailed_description || '',
    product_code: (p, v) => p.code || '',
    product_token: (p, v) => p.token || '',
    is_new: (p, v) => p.new ? 'Yes' : 'No',
    is_recommended: (p, v) => p.recomended ? 'Yes' : 'No',
    is_published: (p, v) => p.published ? 'Yes' : 'No',
    product_images: (p, v) => (p.images || []).join('; '),
    variant_images: (p, v) => (v?.images || []).join('; '),
    ai_categories: (p, v) => (p.ai_categories || []).map(c => c.categoryName).join('; ')
};

/**
 * Column header mappings for CSV
 */
const COLUMN_HEADERS = {
    handle: 'Handle',
    title: 'Title',
    body_html: 'Body (HTML)',
    vendor: 'Vendor',
    type: 'Type',
    tags: 'Tags',
    published: 'Published',
    variant_sku: 'Variant SKU',
    variant_title: 'Variant Title',
    variant_price: 'Variant Price',
    variant_compare_at_price: 'Variant Compare At Price',
    variant_inventory_qty: 'Variant Inventory Qty',
    variant_barcode: 'Variant Barcode',
    image_src: 'Image Src',
    image_alt_text: 'Image Alt Text',
    variant_image: 'Variant Image',
    product_name: 'Product Name',
    variant_name: 'Variant Name',
    sku: 'SKU',
    ean: 'EAN',
    price: 'Price',
    pricelist_name: 'Pricelist',
    vat: 'VAT %',
    price_with_vat: 'Price with VAT',
    stock: 'Stock',
    stock_value: 'Stock Value',
    in_stock: 'In Stock',
    categories: 'Categories',
    short_description: 'Short Description',
    detailed_description: 'Detailed Description',
    product_code: 'Product Code',
    product_token: 'Product Token',
    is_new: 'New',
    is_recommended: 'Recommended',
    is_published: 'Published',
    product_images: 'Product Images',
    variant_images: 'Variant Images',
    ai_categories: 'AI Categories'
};

/**
 * Validates export configuration data
 * @param {Object} data - The configuration data to validate
 * @param {boolean} isUpdate - Whether this is an update (partial data allowed)
 * @returns {{valid: boolean, errors: Array}} Validation result
 */
const validateConfig = (data, isUpdate = false) => {
    const errors = [];

    if (!isUpdate || data.name !== undefined) {
        if (!data.name || typeof data.name !== 'string') {
            errors.push({ field: 'name', message: 'Name is required' });
        } else if (data.name.trim().length === 0) {
            errors.push({ field: 'name', message: 'Name cannot be empty' });
        } else if (data.name.length > 100) {
            errors.push({ field: 'name', message: 'Name cannot exceed 100 characters' });
        }
    }

    if (!isUpdate || data.description !== undefined) {
        if (data.description && typeof data.description !== 'string') {
            errors.push({ field: 'description', message: 'Description must be a string' });
        } else if (data.description && data.description.length > 500) {
            errors.push({ field: 'description', message: 'Description cannot exceed 500 characters' });
        }
    }

    if (!isUpdate || data.preset !== undefined) {
        if (!isUpdate && !data.preset) {
            errors.push({ field: 'preset', message: 'Preset is required' });
        } else if (data.preset && !VALID_PRESETS.includes(data.preset)) {
            errors.push({ field: 'preset', message: 'Invalid preset type' });
        }
    }

    if (!isUpdate || data.selectedFields !== undefined) {
        if (!isUpdate && !data.selectedFields) {
            errors.push({ field: 'selectedFields', message: 'Selected fields are required' });
        } else if (data.selectedFields && !Array.isArray(data.selectedFields)) {
            errors.push({ field: 'selectedFields', message: 'Selected fields must be an array' });
        } else if (data.selectedFields && data.selectedFields.length === 0) {
            errors.push({ field: 'selectedFields', message: 'At least one field must be selected' });
        }
    }

    if (!isUpdate || data.pricelistPriority !== undefined) {
        if (!isUpdate && !data.pricelistPriority) {
            errors.push({ field: 'pricelistPriority', message: 'Pricelist priority is required' });
        } else if (data.pricelistPriority && !Array.isArray(data.pricelistPriority)) {
            errors.push({ field: 'pricelistPriority', message: 'Pricelist priority must be an array' });
        }
    }

    return { valid: errors.length === 0, errors };
};

/**
 * Creates a new export configuration
 * @param {Object} data - Configuration data
 * @param {Object} ownerContext - { sub, email } from Auth0 JWT payload
 * @returns {Promise<Object>} Created configuration
 */
const createExportConfig = async (data, ownerContext = {}) => {
    const validation = validateConfig(data);
    if (!validation.valid) {
        const error = new Error('Validation failed');
        error.code = 'VALIDATION_ERROR';
        error.details = { fields: validation.errors };
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    // Check for duplicate name
    const existing = await collection.findOne({
        name: data.name.trim(),
        isActive: true
    });

    if (existing) {
        const error = new Error('Export with this name already exists');
        error.code = 'DUPLICATE_NAME';
        throw error;
    }

    const now = new Date();
    const config = {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        preset: data.preset,
        selectedFields: data.selectedFields,
        filters: {
            ...DEFAULT_FILTERS,
            ...(data.filters || {}),
            showNew: Boolean(data.filters?.showNew),
            showRecommended: Boolean(data.filters?.showRecommended),
            publishedOnly: Boolean(data.filters?.publishedOnly)
        },
        pricelistPriority: (data.pricelistPriority || []).map((p, idx) => ({
            name: p.name,
            enabled: Boolean(p.enabled !== undefined ? p.enabled : true),
            priority: p.priority ?? idx
        })),
        owner: {
            sub: ownerContext.sub || null,
            email: ownerContext.email || null
        },
        accessList: [],
        apiKeys: [],
        isActive: true,
        createdBy: data.createdBy || null,
        createdAt: now,
        updatedAt: now
    };

    const result = await collection.insertOne(config);
    return { ...config, _id: result.insertedId };
};

/**
 * Retrieves all export configurations visible to the given authContext.
 * @param {Object} options - Query options
 * @param {Object} authContext - { sub, email } from Auth0 JWT payload
 * @returns {Promise<Array>} Array of configurations
 */
const getAllExportConfigs = async (options = {}, authContext = {}) => {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const { sub, email } = authContext;

    // Build ownership/access filter
    const accessConditions = [
        { 'owner.sub': null },          // legacy docs accessible to all export-role users
        { 'owner.sub': { $exists: false } }  // docs without owner field
    ];

    if (sub) {
        accessConditions.push({ 'owner.sub': sub });
        accessConditions.push({ 'accessList.sub': sub });
    }
    if (email) {
        accessConditions.push({ 'accessList.email': email });
    }

    const query = {
        isActive: options.active !== false,
        $or: accessConditions
    };

    if (options.preset) {
        query.preset = options.preset;
    }

    const sort = options.sort || { createdAt: -1 };
    const limit = parseInt(options.limit) || 50;

    const configs = await collection
        .find(query)
        .sort(sort)
        .limit(limit)
        .toArray();

    return configs;
};

/**
 * Retrieves a single export configuration by ID
 * @param {string} id - Configuration ID
 * @returns {Promise<Object|null>} Configuration or null
 */
const getExportConfigById = async (id) => {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const config = await collection.findOne({
        _id: new ObjectId(id),
        isActive: true
    });

    return config;
};

/**
 * Updates an export configuration
 * @param {string} id - Configuration ID
 * @param {Object} data - Update data
 * @returns {Promise<Object>} Updated configuration
 */
const updateExportConfig = async (id, data) => {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const validation = validateConfig(data, true);
    if (!validation.valid) {
        const error = new Error('Validation failed');
        error.code = 'VALIDATION_ERROR';
        error.details = { fields: validation.errors };
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    // Get existing config
    const existing = await collection.findOne({ _id: new ObjectId(id) });
    if (!existing) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    // Check for name conflict if name is being changed
    if (data.name && data.name !== existing.name) {
        const nameConflict = await collection.findOne({
            name: data.name.trim(),
            isActive: true,
            _id: { $ne: new ObjectId(id) }
        });
        if (nameConflict) {
            const error = new Error('Export with this name already exists');
            error.code = 'DUPLICATE_NAME';
            throw error;
        }
    }

    // Build update object
    const updateData = { updatedAt: new Date() };

    if (data.name !== undefined) updateData.name = data.name.trim();
    if (data.description !== undefined) updateData.description = data.description?.trim() || null;
    if (data.preset !== undefined) updateData.preset = data.preset;
    if (data.selectedFields !== undefined) updateData.selectedFields = data.selectedFields;
    if (data.pricelistPriority !== undefined) {
        updateData.pricelistPriority = data.pricelistPriority.map((p, idx) => ({
            name: p.name,
            enabled: Boolean(p.enabled !== undefined ? p.enabled : true),
            priority: p.priority ?? idx
        }));
    }
    if (data.filters !== undefined) {
        // Deep merge filters
        updateData.filters = {
            ...existing.filters,
            ...data.filters,
            showNew: Boolean(data.filters.showNew ?? existing.filters?.showNew),
            showRecommended: Boolean(data.filters.showRecommended ?? existing.filters?.showRecommended),
            publishedOnly: Boolean(data.filters.publishedOnly ?? existing.filters?.publishedOnly)
        };
    }

    const result = await collection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateData },
        { returnDocument: 'after' }
    );

    return result;
};

/**
 * Deletes an export configuration
 * @param {string} id - Configuration ID
 * @param {boolean} hard - Whether to hard delete
 * @returns {Promise<boolean>} Success status
 */
const deleteExportConfig = async (id, hard = false) => {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid ID format');
        error.code = 'INVALID_ID';
        throw error;
    }

    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    let result;
    if (hard) {
        result = await collection.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) {
            const error = new Error('Export configuration not found');
            error.code = 'NOT_FOUND';
            throw error;
        }
    } else {
        result = await collection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isActive: false, updatedAt: new Date() } }
        );
        if (result.matchedCount === 0) {
            const error = new Error('Export configuration not found');
            error.code = 'NOT_FOUND';
            throw error;
        }
    }

    return true;
};

/**
 * Gets price from pricelist based on priority configuration
 * @param {Object} variant - Variant with pricelist
 * @param {Array} pricelistPriority - Priority configuration
 * @returns {Object} Price info
 */
const getPriceFromPriority = (variant, pricelistPriority) => {
    if (!variant?.pricelist || variant.pricelist.length === 0) {
        return { price: 0, vat: 0, name: '' };
    }

    // Sort by priority (ascending)
    const sorted = (pricelistPriority || [])
        .filter(p => p.enabled)
        .sort((a, b) => a.priority - b.priority);

    // Find first pricelist that has a price for this variant
    for (const pl of sorted) {
        const found = variant.pricelist.find(p => p.name === pl.name);
        if (found && found.price !== undefined) {
            return {
                price: found.price,
                vat: found.vat || 0,
                name: found.name
            };
        }
    }

    // Fallback: first available pricelist
    const firstPl = variant.pricelist[0];
    return {
        price: firstPl?.price || 0,
        vat: firstPl?.vat || 0,
        name: firstPl?.name || ''
    };
};

/**
 * Applies filters to products
 * @param {Array} products - Products to filter
 * @param {Object} filters - Filter configuration
 * @returns {Array} Filtered products
 */
const applyFilters = (products, filters) => {
    return products.filter(product => {
        // Search filter
        if (filters.search && filters.search.trim() !== '') {
            const searchLower = filters.search.toLowerCase();
            const matchesSearch =
                (product.product_name?.toLowerCase().includes(searchLower)) ||
                (product.code?.toLowerCase().includes(searchLower)) ||
                (product.token?.toLowerCase().includes(searchLower)) ||
                (product.ean_code?.toLowerCase().includes(searchLower)) ||
                (product.child_products || []).some(v =>
                    v.code?.toLowerCase().includes(searchLower) ||
                    v.ean_code?.toLowerCase().includes(searchLower) ||
                    v.product_name?.toLowerCase().includes(searchLower)
                );
            if (!matchesSearch) return false;
        }

        // Stock status filter
        if (filters.stockStatus !== 'all') {
            const totalStock = (product.child_products || [])
                .reduce((sum, v) => sum + (v.stock_amount || 0), 0);
            if (filters.stockStatus === 'in_stock' && totalStock <= 0) return false;
            if (filters.stockStatus === 'out_of_stock' && totalStock > 0) return false;
        }

        // Price filters
        if (filters.minPrice !== '' || filters.maxPrice !== '') {
            const prices = (product.child_products || []).flatMap(v =>
                (v.pricelist || []).map(p => p.price)
            ).filter(p => p !== undefined);

            if (prices.length > 0) {
                const maxPrice = Math.max(...prices);
                const minPrice = Math.min(...prices);

                if (filters.minPrice !== '' && maxPrice < parseFloat(filters.minPrice)) return false;
                if (filters.maxPrice !== '' && minPrice > parseFloat(filters.maxPrice)) return false;
            }
        }

        // Category filter — backwards-compatible: accepts array or legacy 'all'/string
        const categories = Array.isArray(filters.category)
            ? filters.category
            : (filters.category && filters.category !== 'all' ? [filters.category] : []);
        if (categories.length > 0) {
            if (!categories.some(cat => product.categories?.includes(cat))) return false;
        }

        // AI Export ID filter
        if (filters.aiExportId !== 'all') {
            if (!product.ai_categories?.some(c => c.exportId === filters.aiExportId)) return false;
        }

        // AI Category filter — prefix match, backwards-compatible array or legacy 'all'/string
        const aiCategories = Array.isArray(filters.aiCategory)
            ? filters.aiCategory
            : (filters.aiCategory && filters.aiCategory !== 'all' ? [filters.aiCategory] : []);
        if (aiCategories.length > 0) {
            if (!aiCategories.some(prefix =>
                product.ai_categories?.some(c =>
                    (c.categoryName === prefix || c.categoryName?.startsWith(prefix + ' / ')) &&
                    (filters.aiExportId === 'all' || c.exportId === filters.aiExportId)
                )
            )) return false;
        }

        // Image filter
        if (filters.imageFilter && filters.imageFilter !== 'all') {
            const parentImages = product.images || [];
            const childImages = (product.child_products || []).flatMap(v => v.images || []);
            const hasImages = parentImages.length > 0 || childImages.length > 0;
            if (filters.imageFilter === 'with_images' && !hasImages) return false;
            if (filters.imageFilter === 'without_images' && hasImages) return false;
        }

        // Boolean flags
        if (filters.showNew && !product.new) return false;
        if (filters.showRecommended && !product.recomended) return false;
        if (filters.publishedOnly && !product.published) return false;

        return true;
    });
};

/**
 * Gets field value for CSV/JSON export
 * @param {string} fieldKey - Field key
 * @param {Object} product - Product data
 * @param {Object} variant - Variant data
 * @param {Object} priceInfo - Price information
 * @param {Object} config - Export configuration
 * @param {string} image - Current image URL
 * @returns {*} Field value
 */
const getFieldValue = (fieldKey, product, variant, priceInfo, config, image) => {
    const mapper = FIELD_MAPPINGS[fieldKey];
    if (!mapper) return '';
    return mapper(product, variant, priceInfo, config, image);
};

/**
 * Generates export data rows based on configuration
 * @param {Array} products - Filtered products
 * @param {Object} config - Export configuration
 * @returns {Array} Export data rows
 */
const generateExportRows = (products, config) => {
    const rows = [];
    const isShopify = config.preset === 'shopify';
    const productFields = ['title', 'body_html', 'vendor', 'type', 'tags', 'published'];

    for (const product of products) {
        const variants = product.child_products || [];

        if (isShopify) {
            // Shopify format: product fields only on first row
            const allImages = [...new Set([
                ...(product.images || []),
                ...variants.flatMap(v => v.images || [])
            ])];

            const maxRows = Math.max(variants.length, allImages.length, 1);

            for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
                const row = {};
                const variant = variants[rowIdx] || null;
                const isFirstRow = rowIdx === 0;
                const isImageOnlyRow = !variant && rowIdx >= variants.length && rowIdx < allImages.length;
                const currentImage = allImages[rowIdx] || '';
                const priceInfo = variant ? getPriceFromPriority(variant, config.pricelistPriority) : { price: 0, vat: 0, name: '' };

                for (const fieldKey of config.selectedFields) {
                    if (isImageOnlyRow) {
                        // Image-only rows: only handle and image fields
                        if (fieldKey === 'handle') {
                            row[fieldKey] = product.token;
                        } else if (fieldKey === 'image_src') {
                            row[fieldKey] = currentImage;
                        } else if (fieldKey === 'image_alt_text') {
                            row[fieldKey] = product.product_name;
                        } else {
                            row[fieldKey] = '';
                        }
                    } else {
                        const isProductField = productFields.includes(fieldKey);

                        if (isProductField && !isFirstRow) {
                            row[fieldKey] = '';
                        } else {
                            row[fieldKey] = getFieldValue(fieldKey, product, variant, priceInfo, config, currentImage);
                        }
                    }
                }

                rows.push(row);
            }
        } else {
            // Non-Shopify format: one row per variant
            if (variants.length === 0) {
                const row = {};
                const priceInfo = { price: 0, vat: 0, name: '' };
                for (const fieldKey of config.selectedFields) {
                    row[fieldKey] = getFieldValue(fieldKey, product, null, priceInfo, config, product.images?.[0] || '');
                }
                rows.push(row);
            } else {
                for (const variant of variants) {
                    const row = {};
                    const priceInfo = getPriceFromPriority(variant, config.pricelistPriority);
                    for (const fieldKey of config.selectedFields) {
                        row[fieldKey] = getFieldValue(fieldKey, product, variant, priceInfo, config, variant.images?.[0] || product.images?.[0] || '');
                    }
                    rows.push(row);
                }
            }
        }
    }

    return rows;
};

/**
 * Escapes a value for CSV
 * @param {*} value - Value to escape
 * @returns {string} Escaped value
 */
const escapeCsvValue = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
};

/**
 * Generates CSV export for a configuration
 * @param {string} id - Configuration ID
 * @returns {Promise<{csv: string, filename: string, config: Object}>} CSV data
 */
const generateCsvExport = async (id) => {
    const config = await getExportConfigById(id);
    if (!config) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    const db = getDb();
    const products = await db.collection(PRODUCTS_COLLECTION).find({ active: true }).toArray();
    const filteredProducts = applyFilters(products, config.filters);
    const rows = generateExportRows(filteredProducts, config);

    // Build CSV
    const headers = config.selectedFields.map(f => COLUMN_HEADERS[f] || f);
    const headerLine = headers.map(escapeCsvValue).join(',');
    const dataLines = rows.map(row =>
        config.selectedFields.map(f => escapeCsvValue(row[f])).join(',')
    );

    const csv = [headerLine, ...dataLines].join('\n');
    const filename = `${config.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.csv`;

    return { csv, filename, config };
};

/**
 * Generates JSON export for a configuration — hierarchical structure matching primer.json:
 * code, token, product_name, short_description, detailed_description, category_name,
 * images (array), and variants with code, ean_code, product_name, images, stock_amount, price.
 * @param {string} id - Configuration ID
 * @returns {Promise<Object>} JSON export data
 */
const generateJsonExport = async (id) => {
    const config = await getExportConfigById(id);
    if (!config) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    const db = getDb();
    const products = await db.collection(PRODUCTS_COLLECTION).find({ active: true }).toArray();
    const filteredProducts = applyFilters(products, config.filters);

    const data = filteredProducts.map(product => {
        const variants = product.child_products || [];

        const categoryName = product.ai_categories?.[0]?.categoryName
            || product.categories?.[0]
            || '';

        return {
            code: product.code || '',
            token: product.token || '',
            product_name: product.product_name || '',
            short_description: product.short_description || '',
            detailed_description: product.detailed_description || '',
            category_name: categoryName,
            variants: variants.map(variant => {
                const priceInfo = getPriceFromPriority(variant, config.pricelistPriority);
                const price = priceInfo.vat > 0
                    ? parseFloat((priceInfo.price * (1 + priceInfo.vat / 100)).toFixed(2))
                    : priceInfo.price;

                return {
                    code: variant.code || '',
                    ean_code: variant.ean_code || '',
                    product_name: variant.product_name || '',
                    images: variant.images || [],
                    stock_amount: variant.stock_amount || 0,
                    price
                };
            }),
            images: product.images || []
        };
    });

    return {
        success: true,
        exportName: config.name,
        exportId: config._id.toString(),
        generatedAt: new Date().toISOString(),
        totalProducts: filteredProducts.length,
        data
    };
};

/**
 * Escapes a value for XML text content
 * @param {*} value - Value to escape
 * @returns {string} Escaped string
 */
const escapeXml = (value) => {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
};

// Fields whose values may contain HTML — wrap in CDATA instead of escaping
const HTML_FIELDS = new Set(['body_html', 'short_description', 'detailed_description']);

/**
 * Generates XML export for a configuration — hierarchical structure matching primer.json:
 * code, token, product_name, short_description, detailed_description, category_name,
 * images (wrapped), and variants with code, ean_code, product_name, images, stock_amount, price.
 * @param {string} id - Configuration ID
 * @returns {Promise<{xml: string, filename: string, config: Object}>} XML data
 */
const generateXmlExport = async (id) => {
    const config = await getExportConfigById(id);
    if (!config) {
        const error = new Error('Export configuration not found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    const db = getDb();
    const products = await db.collection(PRODUCTS_COLLECTION).find({ active: true }).toArray();
    const filteredProducts = applyFilters(products, config.filters);

    const productXmls = filteredProducts.map(product => {
        const variants = product.child_products || [];

        // category_name: first ai_category name, or first plain category, or empty
        const categoryName = product.ai_categories?.[0]?.categoryName
            || product.categories?.[0]
            || '';

        // Product-level images
        const productImagesXml = (product.images || [])
            .map(img => `      <image>${escapeXml(img)}</image>`)
            .join('\n');
        const imagesBlock = productImagesXml
            ? `\n    <images>\n${productImagesXml}\n    </images>`
            : '\n    <images/>';

        // Variants
        const variantItems = variants.map(variant => {
            const priceInfo = getPriceFromPriority(variant, config.pricelistPriority);
            const price = priceInfo.vat > 0
                ? (priceInfo.price * (1 + priceInfo.vat / 100)).toFixed(2)
                : priceInfo.price.toFixed(2);

            const variantImagesXml = (variant.images || [])
                .map(img => `          <image>${escapeXml(img)}</image>`)
                .join('\n');
            const variantImagesBlock = variantImagesXml
                ? `\n        <images>\n${variantImagesXml}\n        </images>`
                : '\n        <images/>';

            return [
                '      <variant>',
                `        <code>${escapeXml(variant.code)}</code>`,
                `        <ean_code>${escapeXml(variant.ean_code)}</ean_code>`,
                `        <product_name>${escapeXml(variant.product_name)}</product_name>`,
                variantImagesBlock,
                `        <stock_amount>${escapeXml(variant.stock_amount)}</stock_amount>`,
                `        <price>${price}</price>`,
                '      </variant>'
            ].join('\n');
        });

        const variantsBlock = variantItems.length > 0
            ? `\n    <variants>\n${variantItems.join('\n')}\n    </variants>`
            : '\n    <variants/>';

        return [
            '  <product>',
            `    <code>${escapeXml(product.code)}</code>`,
            `    <token>${escapeXml(product.token)}</token>`,
            `    <product_name>${escapeXml(product.product_name)}</product_name>`,
            `    <short_description><![CDATA[${product.short_description || ''}]]></short_description>`,
            `    <detailed_description><![CDATA[${product.detailed_description || ''}]]></detailed_description>`,
            `    <category_name>${escapeXml(categoryName)}</category_name>`,
            imagesBlock,
            variantsBlock,
            '  </product>'
        ].join('\n');
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<products>\n${productXmls.join('\n')}\n</products>`;
    const filename = `${config.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.xml`;

    return { xml, filename, config };
};

/**
 * Creates required MongoDB indexes and backfills existing documents with
 * owner/accessList/apiKeys fields for the migration period.
 * Safe to call multiple times (idempotent).
 */
const ensureIndexesAndMigrate = async () => {
    try {
        const db = getDb();
        const collection = db.collection(COLLECTION_NAME);

        // Create indexes
        await collection.createIndex({ 'owner.sub': 1 });
        await collection.createIndex({ 'accessList.email': 1 });
        await collection.createIndex({ 'apiKeys.keyHash': 1 }, { sparse: true });

        // Backfill existing docs that lack owner/accessList/apiKeys fields
        await collection.updateMany(
            { owner: { $exists: false } },
            { $set: { owner: { sub: null, email: null }, accessList: [], apiKeys: [] } }
        );

        console.log('[customExport] Indexes ensured and migration complete.');
    } catch (error) {
        console.error('[customExport] Index/migration error:', error.message);
    }
};

module.exports = {
    createExportConfig,
    getAllExportConfigs,
    getExportConfigById,
    updateExportConfig,
    deleteExportConfig,
    generateCsvExport,
    generateJsonExport,
    generateXmlExport,
    ensureIndexesAndMigrate,
    VALID_PRESETS,
    COLUMN_HEADERS,
    DEFAULT_FILTERS
};
