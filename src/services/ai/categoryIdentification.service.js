const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/mongo.service');
const { ObjectId } = require('mongodb');
const { logAiUsage } = require('./analytics.service');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
    throw new Error('ANTHROPIC_API_KEY must be set in environment variables.');
}
const anthropic = new Anthropic({ apiKey: API_KEY });

const MODEL_NAME = 'claude-haiku-4-5';
const BATCH_SIZE = 30;

// One progress doc per export (latest run wins) — the UI polls this while a run is going so
// the user can see batches advancing instead of a silent background job.
const RUNS_COLLECTION = 'ai_categorization_runs';

/** Upserts the run-progress doc for an export. Best-effort: never blocks the run itself. */
async function setRunProgress(exportId, patch) {
    try {
        await getDb().collection(RUNS_COLLECTION).updateOne(
            { exportId: exportId.toString() },
            { $set: { ...patch, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (e) {
        console.error('Failed to record AI run progress:', e.message);
    }
}

/** Latest categorization run for an export, or null if it has never run. */
async function getRunStatus(exportId) {
    const run = await getDb().collection(RUNS_COLLECTION).findOne(
        { exportId: exportId.toString() },
        { projection: { _id: 0 } }
    );
    return run || null;
}

// Structured-outputs JSON schema (output_config.format) — the response is guaranteed to parse
// against this. `additionalProperties: false` is required on every object by the API.
const responseSchema = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    code: { type: 'string' },
                    catId: { type: 'string' }
                },
                required: ['code', 'catId'],
                additionalProperties: false
            }
        }
    },
    required: ['results'],
    additionalProperties: false
};

/**
 * Processes a batch of products to identify their categories using Claude (Haiku).
 * @param {Array<Object>} products - The batch of products to categorize.
 * @param {Array<{id: string, label: string}>} validCategories - The list of valid categories for the AI to choose from.
 * @param {string} exportId - The identifier for the category export (e.g., 'tris').
 * @returns {Promise<Array<{code: string, catId: string}>>} A promise that resolves with the categorized results.
 */
async function processBatch(products, validCategories, exportId) {
    try {
        const system = `You are a Product Mapping Assistant.
You will be given a list of products. Some products may have a 'child_products' array which represent product variants.
Use the information in 'child_products' to get more context about the parent product, but ONLY return a category for the parent product.
Do NOT categorize items inside the 'child_products' array.
Map each parent product to the most specific and correct category ID from this list: ${JSON.stringify(validCategories)}.
If you are unsure, use the ID for "Ostalo" or a similar general category if available.`;

        const message = await anthropic.messages.create({
            model: MODEL_NAME,
            max_tokens: 8192,
            // The system prompt (incl. the category list) is identical across all batches of a
            // run — cache it so every batch after the first reads it at ~0.1× input price.
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            output_config: { format: { type: 'json_schema', schema: responseSchema } },
            messages: [{ role: 'user', content: `Categorize these products: ${JSON.stringify(products)}` }]
        });

        // Log AI usage analytics (mapped to the shape `logAiUsage`/the aiAnalytics collection expects).
        const u = message.usage || {};
        const inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        logAiUsage(exportId, {
            promptTokenCount: inputTokens,
            candidatesTokenCount: u.output_tokens || 0,
            totalTokenCount: inputTokens + (u.output_tokens || 0)
        }, MODEL_NAME);

        if (message.stop_reason === 'refusal') {
            console.error('Batch Error: model refused the request.');
            return { results: [], error: 'The model refused the request.' };
        }
        if (message.stop_reason === 'max_tokens') {
            console.warn('Batch warning: output truncated at max_tokens — results may be incomplete.');
        }

        const text = message.content.find((b) => b.type === 'text')?.text || '{}';
        const jsonResponse = JSON.parse(text);
        return { results: jsonResponse.results || [], error: null };

    } catch (error) {
        console.error('Batch Error:', error.message);
        if (error instanceof Anthropic.APIError) {
            console.error(`Anthropic API error ${error.status} (${error.type || 'unknown'})`);
        }
        // Surfaced on the run-progress doc so the UI can show WHY a run produced nothing.
        return { results: [], error: error.message };
    }
}

/**
 * Identifies and saves categories for products based on a given export ID.
 * @param {string} exportId - The identifier for the category export (e.g., 'tris').
 */
async function identifyProductCategories(exportId) {
    try {
        const db = getDb();
        const productsCollection = db.collection('products');
        const categoriesCollection = db.collection('categories');

        // 1. Fetch valid categories for the given exportId from MongoDB
        const categoriesCursor = categoriesCollection.find({exportId: exportId.toString()});
        const validCategories = await categoriesCursor.toArray();

        if (validCategories.length === 0) {
            console.warn(`No categories found for exportId: "${exportId}". Skipping categorization.`);
            const now = new Date();
            await setRunProgress(exportId, {
                status: 'failed', error: 'No categories defined for this category set — add categories first.',
                total: 0, processed: 0, categorized: 0, batch: 0, totalBatches: 0, startedAt: now, finishedAt: now
            });
            return { exportId, productsFound: 0, productsCategorized: 0 };
        }

        // 2. Find products that do NOT have a category for this exportId yet
        const productsToCategorize = await productsCollection.find({
            'ai_categories.exportId': { $ne: exportId }
        }).toArray();

        if (productsToCategorize.length === 0) {
            console.log(`No new products to categorize for exportId "${exportId}". All products are up to date.`);
            const now = new Date();
            await setRunProgress(exportId, {
                status: 'done', error: null,
                total: 0, processed: 0, categorized: 0, batch: 0, totalBatches: 0, startedAt: now, finishedAt: now
            });
            return { exportId, productsFound: 0, productsCategorized: 0 };
        }

        console.log(`Found ${productsToCategorize.length} new products to categorize for exportId "${exportId}".`);
        const categoriesForPrompt = validCategories.map(c => ({ id: c._id.toString(), label: c.label }));
        const categoryMap = new Map(categoriesForPrompt.map(c => [c.id, c.label]));
        const totalBatches = Math.ceil(productsToCategorize.length / BATCH_SIZE);
        let totalCategorized = 0;
        let lastError = null;

        await setRunProgress(exportId, {
            status: 'running', error: null,
            total: productsToCategorize.length, processed: 0, categorized: 0,
            batch: 0, totalBatches, startedAt: new Date(), finishedAt: null
        });

        for (let i = 0; i < productsToCategorize.length; i += BATCH_SIZE) {
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const batch = productsToCategorize.slice(i, i + BATCH_SIZE);
            console.log(`Processing batch ${batchNum}/${totalBatches} for exportId "${exportId}"...`);

            const { results: batchResults, error: batchError } = await processBatch(batch, categoriesForPrompt, exportId);
            if (batchError) lastError = batchError;

            const bulkOps = batchResults.map(result => {
                const categoryName = categoryMap.get(String(result.catId));
                if (!categoryName) {
                    console.warn(`Warning: Category ID ${result.catId} not found for product code ${result.code}. Skipping.`);
                    return null;
                }
                return {
                    updateOne: {
                        filter: { code: result.code },
                        update: {
                            $addToSet: {
                                ai_categories: {
                                    exportId: exportId,
                                    categoryId: result.catId,
                                    categoryName: categoryName
                                }
                            }
                        }
                    }
                };
            }).filter(op => op !== null);

            if (bulkOps.length > 0) {
                await productsCollection.bulkWrite(bulkOps);
                totalCategorized += bulkOps.length;
                console.log(`Batch ${batchNum}/${totalBatches} saved — ${bulkOps.length} products written to DB.`);
            } else {
                console.log(`Batch ${batchNum}/${totalBatches} — no valid results to save.`);
            }

            await setRunProgress(exportId, {
                batch: batchNum,
                processed: Math.min(i + BATCH_SIZE, productsToCategorize.length),
                categorized: totalCategorized,
                error: lastError
            });
        }

        await setRunProgress(exportId, {
            // Nothing written AND batches errored → the run failed; partial results stay 'done'.
            status: totalCategorized === 0 && lastError ? 'failed' : 'done',
            error: lastError,
            finishedAt: new Date()
        });

        return {
            exportId,
            productsFound: productsToCategorize.length,
            productsCategorized: totalCategorized,
        };

    } catch (error) {
        console.error(`Orchestrator Error for exportId "${exportId}":`, error.message);
        await setRunProgress(exportId, { status: 'failed', error: error.message, finishedAt: new Date() });
        throw error;
    }
}

/**
 * Retrieves the category name for a specific product code and export ID from the database.
 * @param {string} productCode The product code to look up.
 * @param {string} exportId The identifier for the category export (e.g., 'tris').
 * @returns {Promise<string|null>} A promise that resolves to the category name, or null if not found.
 */
async function getCategoryNameForProductCode(productCode, exportId) {
    try {
        const db = getDb();
        const product = await db.collection('products').findOne(
            { code: productCode },
            { projection: { ai_categories: 1 } }
        );

        const categoryInfo = product?.ai_categories?.find(cat => cat.exportId === exportId);

        return categoryInfo ? categoryInfo.categoryName : null;
    } catch (error) {
        console.error(`Could not get category for product code "${productCode}" and exportId "${exportId}": ${error.message}`);
        return null;
    }
}

/**
 * Categorizes an array of arbitrary (third-party) products against the
 * categories defined for a given exportId.  Results are returned directly
 * and are NOT persisted to the database.
 *
 * @param {string} exportId - The export whose category list should be used.
 * @param {Array<Object>} products - Products to categorize. Each object must
 *   have at least { code, name } and may include any other descriptive fields.
 * @returns {Promise<{results: Array<{code: string, categoryId: string, categoryName: string}>}>}
 */
async function categorizeExternalProducts(exportId, products) {
    const db = getDb();
    const categoriesCollection = db.collection('categories');

    const validCategories = await categoriesCollection.find({ exportId: exportId.toString() }).toArray();

    if (validCategories.length === 0) {
        throw new Error(`No categories found for exportId "${exportId}".`);
    }

    const categoriesForPrompt = validCategories.map(c => ({ id: c._id.toString(), label: c.label }));
    const categoryMap = new Map(categoriesForPrompt.map(c => [c.id, c.label]));

    const allResults = [];

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
        const batch = products.slice(i, i + BATCH_SIZE);
        const { results: batchResults } = await processBatch(batch, categoriesForPrompt, `external:${exportId}`);

        for (const result of batchResults) {
            const categoryName = categoryMap.get(String(result.catId));
            if (categoryName) {
                allResults.push({
                    code: result.code,
                    categoryId: result.catId,
                    categoryName,
                });
            }
        }
    }

    return { results: allResults };
}

module.exports = { identifyProductCategories, getCategoryNameForProductCode, categorizeExternalProducts, getRunStatus };