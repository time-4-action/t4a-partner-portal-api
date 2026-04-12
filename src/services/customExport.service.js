const { getDb } = require('./db/mongo.service');
const { ObjectId } = require('mongodb');

const COLLECTION_NAME = 'export_configs';
const PRODUCTS_COLLECTION = 'products';

const stripHtml = (str) => (str || '').replace(/<[^>]*>/g, '');

const formatDate = (val) => {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
};

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
    publishedOnly: false,
    excludeCloseOut: false
};

/**
 * Expands a category path into all hierarchical prefixes.
 * e.g. "Electronics / Phones" → ["Electronics", "Electronics / Phones"]
 */
const expandCategoryToTags = (categoryName) => {
    const parts = categoryName.split(' / ');
    return parts.map((_, i) => parts.slice(0, i + 1).join(' / '));
};

/**
 * Field mappings for CSV generation
 */
const FIELD_MAPPINGS = {
    // Shopify fields
    handle: (p, v) => p.token || '',
    title: (p, v) => p.product_name || '',
    body_html: (p) => p.detailed_description || p.short_description || '',
    vendor: () => 'Patrik International',
    type: (p, v) => p.categories?.[0] || '',
    tags: (p, v, priceInfo, config) => {
        const aiExportId = config?.filters?.aiExportId;
        const baseTags = aiExportId && aiExportId !== 'all'
            ? (() => {
                const filtered = (p.ai_categories || []).filter(c => c.exportId === aiExportId);
                return filtered.length > 0
                    ? [...new Set(filtered.flatMap(c => expandCategoryToTags(c.categoryName)))]
                    : (p.categories || []);
            })()
            : (p.categories || []);
        const extraTags = [p.new ? 'new' : '', p.recomended ? 'recommended' : ''].filter(Boolean);
        return [...baseTags, ...extraTags].join(', ');
    },
    published: (p, v) => p.published ? 'TRUE' : 'FALSE',
    variant_sku: (p, v) => v?.code || p.code || '',
    variant_title: (p, v) => {
        if (v?.size) return v.size;
        if (v?.product_name && p.product_name) {
            const parentName = p.product_name.trim();
            const variantName = v.product_name.trim();
            if (variantName.startsWith(parentName)) {
                const suffix = variantName.slice(parentName.length).trim();
                if (suffix) return suffix;
            }
            // Try extracting trailing number as size (e.g. "Patrik QT-Wave 71" → "71", "85 l" → "85", "85 V2 - GET" → "85")
            const trailingNum = variantName.match(/\s(\d+(?:[.,]\d+)?)\s*l?\s*(?:V\d+)?\s*(?:-\s*\w+)*\s*$/i);
            if (trailingNum) return trailingNum[1];
        }
        return v?.product_name || p.product_name || '';
    },
    variant_price: (p, v, priceInfo) => priceInfo.price.toFixed(2),
    variant_compare_at_price: (p, v, priceInfo, config) => {
        const pricelist = v?.pricelist ?? (p.child_products?.length === 0 ? p.pricelist : null);
        if (!pricelist) return '';
        const enabled = (config?.pricelistPriority || []).filter(pl => pl.enabled).sort((a, b) => a.priority - b.priority);
        if (enabled.length < 2) return '';
        const second = enabled[1];
        const found = pricelist.find(pl => pl.name === second.name);
        return found?.price != null ? found.price.toFixed(2) : '';
    },
    variant_inventory_tracker: () => 'shopify',
    variant_inventory_qty: (p, v) => v != null ? (v.stock_amount || 0) : (p.stock_amount || 0),
    variant_inventory_policy: (p, v) => (v?.allow_backorder || p.allow_backorder) ? 'continue' : 'deny',
    variant_fulfillment_service: () => 'manual',
    variant_barcode: (p, v) => v?.ean_code || p.ean_code || '',
    image_src: (p, v, priceInfo, config, image) => image || '',
    image_alt_text: (p, v) => p.product_name || '',
    variant_image: (p, v) => v?.images?.[0] || p.images?.[0] || '',

    // Simple/Detailed fields
    product_name: (p, v) => p.product_name || '',
    variant_name: (p, v) => v?.product_name || p.product_name || '',
    sku: (p, v) => v?.code || p.code || '',
    ean: (p, v) => v?.ean_code || p.ean_code || '',
    price: (p, v, priceInfo) => priceInfo.price.toFixed(2),
    pricelist_name: (p, v, priceInfo) => priceInfo.name || '',
    vat: (p, v, priceInfo) => priceInfo.vat,
    price_with_vat: (p, v, priceInfo) => (priceInfo.price * (1 + priceInfo.vat / 100)).toFixed(2),
    stock: (p, v) => v != null ? (v.stock_amount || 0) : (p.stock_amount || 0),
    stock_value: (p, v, priceInfo) => {
        const qty = v != null ? (v.stock_amount || 0) : (p.stock_amount || 0);
        return (qty * priceInfo.price).toFixed(2);
    },
    in_stock: (p, v) => {
        const qty = v != null ? (v.stock_amount || 0) : (p.stock_amount || 0);
        return qty > 0 ? 'Yes' : 'No';
    },
    categories: (p, v, priceInfo, config) => {
        const aiExportId = config?.filters?.aiExportId;
        if (aiExportId && aiExportId !== 'all') {
            const filtered = (p.ai_categories || []).filter(c => c.exportId === aiExportId);
            if (filtered.length > 0) {
                return [...new Set(filtered.flatMap(c => expandCategoryToTags(c.categoryName)))].join(', ');
            }
        }
        return (p.categories || []).join(', ');
    },
    short_description: (p) => stripHtml(p.short_description || ''),
    detailed_description: (p) => stripHtml(p.detailed_description || ''),
    product_code: (p, v) => p.code || '',
    product_token: (p, v) => p.token || '',
    is_new: (p, v) => p.new ? 'Yes' : 'No',
    is_recommended: (p, v) => p.recomended ? 'Yes' : 'No',
    is_published: (p, v) => p.published ? 'Yes' : 'No',
    product_images: (p, v) => (p.images || []).join('; '),
    variant_images: (p, v) => (v?.images || []).join('; '),
    all_images: (p, v) => [...new Set([...(p.images || []), ...(v?.images || [])])].join('; '),
    image_url: (p, v) => v?.images?.[0] || p.images?.[0] || '',
    variant_token: (p, v) => v?.token || p.token || '',
    variant_code: (p, v) => v?.code || p.code || '',
    is_active: (p) => p.active ? 'Yes' : 'No',
    created_at: (p) => formatDate(p.createdAt || p.created_at),
    updated_at: (p) => formatDate(p.updatedAt || p.updated_at),

    // AI / Collection fields
    ai_categories: (p, v, priceInfo, config) => {
        const filtered = config?.filters?.aiExportId && config.filters.aiExportId !== 'all'
            ? (p.ai_categories || []).filter(c => c.exportId === config.filters.aiExportId)
            : (p.ai_categories || []);
        return filtered.map(c => c.categoryName).join('; ');
    },
    ai_tags: (p, v, priceInfo, config) => {
        const filtered = config?.filters?.aiExportId && config.filters.aiExportId !== 'all'
            ? (p.ai_categories || []).filter(c => c.exportId === config.filters.aiExportId)
            : (p.ai_categories || []);
        const leaf = config?.aiLeafMode?.ai_tags !== false; // default true (leaf)
        return filtered.map(c => leaf ? c.categoryName.split(' / ').pop().trim() : c.categoryName).join(', ');
    },
    ai_category_names: (p, v, priceInfo, config) => {
        const filtered = config?.filters?.aiExportId && config.filters.aiExportId !== 'all'
            ? (p.ai_categories || []).filter(c => c.exportId === config.filters.aiExportId)
            : (p.ai_categories || []);
        const leaf = config?.aiLeafMode?.ai_category_names === true; // default false (full path)
        return filtered.map(c => leaf ? c.categoryName.split(' / ').pop().trim() : c.categoryName).join('; ');
    },
    ai_category_ids: (p, v, priceInfo, config) => {
        const filtered = config?.filters?.aiExportId && config.filters.aiExportId !== 'all'
            ? (p.ai_categories || []).filter(c => c.exportId === config.filters.aiExportId)
            : (p.ai_categories || []);
        return filtered.map(c => c.categoryId).join('; ');
    },
    ai_category_full: (p, v, priceInfo, config) => {
        const filtered = config?.filters?.aiExportId && config.filters.aiExportId !== 'all'
            ? (p.ai_categories || []).filter(c => c.exportId === config.filters.aiExportId)
            : (p.ai_categories || []);
        return filtered.map(c => `${c.categoryName} [${c.categoryId}]`).join('; ');
    },
    ai_export_ids: (p) => {
        return [...new Set((p.ai_categories || []).map(c => c.exportId))].join('; ');
    },
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
    variant_inventory_tracker: 'Variant Inventory Tracker',
    variant_inventory_qty: 'Variant Inventory Qty',
    variant_inventory_policy: 'Variant Inventory Policy',
    variant_fulfillment_service: 'Variant Fulfillment Service',
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
    categories: 'Tags',
    short_description: 'Short Description',
    detailed_description: 'Detailed Description',
    product_code: 'Product Code',
    product_token: 'Product Token',
    is_new: 'New',
    is_recommended: 'Recommended',
    is_published: 'Published',
    product_images: 'Product Images',
    variant_images: 'Variant Images',
    all_images: 'All Images',
    image_url: 'Image URL',
    variant_token: 'Variant Token',
    variant_code: 'Variant Code',
    is_active: 'Active',
    created_at: 'Created At',
    updated_at: 'Updated At',
    ai_categories: 'AI Categories',
    ai_tags: 'Collection',
    ai_category_names: 'Collection',
    ai_category_ids: 'Collection IDs',
    ai_category_full: 'Collection (Full)',
    ai_export_ids: 'AI Export IDs',
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
            publishedOnly: Boolean(data.filters?.publishedOnly),
            excludeCloseOut: Boolean(data.filters?.excludeCloseOut)
        },
        pricelistPriority: (data.pricelistPriority || []).map((p, idx) => ({
            name: p.name,
            enabled: Boolean(p.enabled !== undefined ? p.enabled : true),
            priority: p.priority ?? idx
        })),
        aiLeafMode: {
            ai_tags: data.aiLeafMode?.ai_tags === true,           // default false (full hierarchy)
            ai_category_names: data.aiLeafMode?.ai_category_names === true, // default false (full path)
        },
        inventoryLocationName: data.inventoryLocationName?.trim() || null,
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
            publishedOnly: Boolean(data.filters.publishedOnly ?? existing.filters?.publishedOnly),
            excludeCloseOut: Boolean(data.filters.excludeCloseOut ?? existing.filters?.excludeCloseOut)
        };
    }
    if (data.aiLeafMode !== undefined) {
        updateData.aiLeafMode = {
            ai_tags: data.aiLeafMode?.ai_tags !== false,
            ai_category_names: data.aiLeafMode?.ai_category_names === true,
        };
    }
    if (data.inventoryLocationName !== undefined) {
        updateData.inventoryLocationName = data.inventoryLocationName?.trim() || null;
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
const applyFilters = (products, filters, pricelistPriority = []) => {
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

        // Stock status filter — check child_products first, fall back to parent stock_amount
        if (filters.stockStatus !== 'all') {
            const variants = product.child_products || [];
            const totalStock = variants.length > 0
                ? variants.reduce((sum, v) => sum + (v.stock_amount || 0), 0)
                : (product.stock_amount || 0);
            if (filters.stockStatus === 'in_stock' && totalStock <= 0) return false;
            if (filters.stockStatus === 'out_of_stock' && totalStock > 0) return false;
        }

        // Price filters — use priority-based price; fall back to parent pricelist when no variants
        if (filters.minPrice !== '' || filters.maxPrice !== '') {
            const variants = product.child_products || [];
            const prices = variants.length > 0
                ? variants.map(v => getPriceFromPriority(v, pricelistPriority).price).filter(p => p > 0)
                : [getPriceFromPriority(product, pricelistPriority).price].filter(p => p > 0);
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
        if (filters.excludeCloseOut && product.product_name?.toUpperCase().includes('CLOSE OUT')) return false;
        if (filters.excludeCloseOut && product.images?.some(img => img?.toLowerCase().includes('close-out'))) return false;

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
    const productFields = ['title', 'body_html', 'vendor', 'type', 'tags', 'ai_tags', 'published'];

    for (const product of products) {
        const variants = product.child_products || [];

        if (isShopify) {
            // Shopify format: product fields only on first row.
            // Variant rows: image_src = variant's own first image.
            // Parent images all go on image-only rows below the variant rows.
            const productImages = [...new Set(product.images || [])];
            const variantRowCount = Math.max(variants.length, 1);
            const maxRows = variantRowCount + productImages.length;

            for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
                const row = {};
                const variant = variants[rowIdx] || null;
                const isFirstRow = rowIdx === 0;
                const isImageOnlyRow = rowIdx >= variantRowCount;
                // Variant rows use the variant's own image; image-only rows use parent images
                const currentImage = isImageOnlyRow
                    ? productImages[rowIdx - variantRowCount] || ''
                    : (variant?.images?.[0] || variants[0]?.images?.[0] || '');
                // When no variants, use the parent product's own pricelist for price
                const priceSource = variant ?? (variants.length === 0 ? product : null);
                const priceInfo = priceSource ? getPriceFromPriority(priceSource, config.pricelistPriority) : { price: 0, vat: 0, name: '' };

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
                // Use parent product's own pricelist when there are no child_products
                const priceInfo = getPriceFromPriority(product, config.pricelistPriority);
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
    const str = String(value).replace(/\r\n|\r|\n/g, ' ');
    if (str.includes(',') || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
};

/**
 * Generates inventory CSV rows in the Shopify inventory import format.
 * Fixed columns: Handle, Title, Option1 Name, Option1 Value, Option2 Name, Option2 Value,
 *                Option3 Name, Option3 Value, SKU, HS Code, COO, {locationName}
 * @param {Array} products - Filtered products
 * @param {string} locationName - Shopify location name (exact case match)
 * @returns {{ headers: string[], rows: string[][] }} Headers and data rows
 */
const generateInventoryRows = (products, locationName) => {
    const headers = [
        'Handle', 'Title', 'Option1 Name', 'Option1 Value',
        'Option2 Name', 'Option2 Value', 'Option3 Name', 'Option3 Value',
        'SKU', 'HS Code', 'COO', locationName || 'Location'
    ];

    const rows = [];
    for (const product of products) {
        const variants = product.child_products || [];
        const handle = product.token || '';
        const title = product.product_name || '';

        if (variants.length === 0) {
            // Product without variants
            rows.push([
                handle, title, 'Variant', title,
                '', '', '', '',
                product.code || '', '', '',
                String(product.stock_amount || 0)
            ]);
        } else {
            for (const variant of variants) {
                // Derive option value from size, or variant name suffix, or full variant name
                let optionValue = '';
                if (variant.size) {
                    optionValue = variant.size;
                } else if (variant.product_name && product.product_name) {
                    const parentName = product.product_name.trim();
                    const variantName = variant.product_name.trim();
                    if (variantName.startsWith(parentName)) {
                        const suffix = variantName.slice(parentName.length).trim();
                        optionValue = suffix || variantName;
                    } else {
                        // Try extracting trailing number as size (e.g. "Patrik QT-Wave 71" → "71", "85 l" → "85", "85 V2 - GET" → "85")
                        const trailingNum = variantName.match(/\s(\d+(?:[.,]\d+)?)\s*l?\s*(?:V\d+)?\s*(?:-\s*\w+)*\s*$/i);
                        optionValue = trailingNum ? trailingNum[1] : variantName;
                    }
                } else {
                    optionValue = variant.product_name || title;
                }

                rows.push([
                    handle, title, 'Variant', optionValue,
                    '', '', '', '',
                    variant.code || '', '', '',
                    String(variant.stock_amount || 0)
                ]);
            }
        }
    }

    return { headers, rows };
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
    const filteredProducts = applyFilters(products, config.filters, config.pricelistPriority);

    let csv;

    if (config.preset === 'inventory') {
        // Inventory format: fixed Shopify-compatible columns with location-based stock
        const { headers, rows } = generateInventoryRows(filteredProducts, config.inventoryLocationName);
        const headerLine = headers.map(escapeCsvValue).join(',');
        const dataLines = rows.map(row => row.map(escapeCsvValue).join(','));
        csv = [headerLine, ...dataLines].join('\n');
    } else {
        const rows = generateExportRows(filteredProducts, config);
        const headers = config.selectedFields.map(f => COLUMN_HEADERS[f] || f);
        const headerLine = headers.map(escapeCsvValue).join(',');
        const dataLines = rows.map(row =>
            config.selectedFields.map(f => escapeCsvValue(row[f])).join(',')
        );
        csv = [headerLine, ...dataLines].join('\n');
    }

    const filename = `${config.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.csv`;

    return { csv, filename, config };
};

/**
 * Resolves the primary category name for a product.
 * Uses ai_categories filtered by aiExportId config, falls back to categories[0].
 * @param {Object} product - Product document
 * @param {Object} config - Export configuration
 * @returns {string} Category name
 */
const resolveCategoryName = (product, config) => {
    const aiExportId = config?.filters?.aiExportId;
    if (product.ai_categories?.length > 0) {
        const filtered = aiExportId && aiExportId !== 'all'
            ? product.ai_categories.filter(c => c.exportId === aiExportId)
            : product.ai_categories;
        if (filtered.length > 0) return filtered[0].categoryName;
    }
    return product.categories?.[0] || '';
};

/**
 * Resolves all hierarchical tag combinations for a product.
 * e.g. AI category "Electronics / Phones" → ["Electronics", "Electronics / Phones"]
 */
const resolveTagsArray = (product, config) => {
    const aiExportId = config?.filters?.aiExportId;
    if (aiExportId && aiExportId !== 'all') {
        const filtered = (product.ai_categories || []).filter(c => c.exportId === aiExportId);
        if (filtered.length > 0) {
            return [...new Set(filtered.flatMap(c => expandCategoryToTags(c.categoryName)))];
        }
    }
    return product.categories || [];
};

/**
 * Generates JSON export — product-centric nested structure matching primer.json format.
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
    const filteredProducts = applyFilters(products, config.filters, config.pricelistPriority);

    const data = filteredProducts.map(product => {
        const variants = (product.child_products || []).map(v => {
            const priceInfo = getPriceFromPriority(v, config.pricelistPriority);
            const variant = {
                code: v.code || '',
                ean_code: v.ean_code || '',
                product_name: v.product_name || '',
                images: v.images || [],
                stock_amount: v.stock_amount || 0,
                price: priceInfo.price,
            };
            if (v.size) variant.size = v.size;
            return variant;
        });

        return {
            code: product.code || '',
            token: product.token || '',
            product_name: product.product_name || '',
            short_description: product.short_description || '',
            detailed_description: product.detailed_description || '',
            tags: resolveTagsArray(product, config),
            variants,
            images: product.images || [],
        };
    });

    return {
        success: true,
        exportName: config.name,
        exportId: config._id.toString(),
        generatedAt: new Date().toISOString(),
        totalProducts: data.length,
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
 * Generates XML export — product-centric nested structure matching primer (1).xml format.
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
    const filteredProducts = applyFilters(products, config.filters, config.pricelistPriority);

    const productXmls = filteredProducts.map(product => {
        const tags = resolveTagsArray(product, config);
        const shortDesc = product.short_description || '';
        const detailedDesc = product.detailed_description || '';

        const productImages = (product.images || [])
            .map(img => `      <image>${escapeXml(img)}</image>`)
            .join('\n');

        const variants = (product.child_products || []);
        const variantXmls = variants.map(v => {
            const priceInfo = getPriceFromPriority(v, config.pricelistPriority);
            const price = priceInfo.price.toFixed(2);
            const variantImages = (v.images || [])
                .map(img => `          <image>${escapeXml(img)}</image>`)
                .join('\n');

            const variantFeatures = [];
            if (v.size) {
                variantFeatures.push(
                    `          <feature>\n            <name>Size</name>\n            <value>${escapeXml(v.size)}</value>\n            <description></description>\n          </feature>`
                );
            }
            const variantFeaturesXml = variantFeatures.length > 0
                ? `\n        <features>\n${variantFeatures.join('\n')}\n        </features>`
                : '';

            return `      <variant>
        <id>${escapeXml(v.code || '')}</id>
        <ean>${escapeXml(v.ean_code || '')}</ean>
        <name>${escapeXml(v.product_name || '')}</name>
        <stock>${v.stock_amount || 0}</stock>
        <recommendedRetailPriceWithVat>${price}</recommendedRetailPriceWithVat>
        <images>
${variantImages}
        </images>${variantFeaturesXml}
      </variant>`;
        }).join('\n');

        const variantsBlock = variants.length > 0
            ? `\n    <variants>\n${variantXmls}\n    </variants>`
            : '';

        return `  <product>
    <id>${escapeXml(product.code || '')}</id>
    <name>${escapeXml(product.product_name || '')}</name>
    <descriptionSI><![CDATA[${shortDesc}]]></descriptionSI>
    <descriptionEN><![CDATA[${detailedDesc}]]></descriptionEN>
    <features>
${tags.map(tag => `      <feature>\n        <name>Tags</name>\n        <value>${escapeXml(tag)}</value>\n        <description></description>\n      </feature>`).join('\n')}
    </features>
    <images>
${productImages}
    </images>${variantsBlock}
  </product>`;
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
