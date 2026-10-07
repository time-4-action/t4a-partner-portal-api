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

// One progress doc per RUN KEY (latest run wins) — the UI polls this while a run is going so
// the user can see batches advancing instead of a silent background job. The key is the
// exportId for the Patrik catalogue, and `<exportId>:<feedId>` for an Own Source feed, so a
// feed run never clobbers the catalogue run's progress for the same category set.
const RUNS_COLLECTION = 'ai_categorization_runs';

/** Run-progress key for one feed categorized against one category set. */
const feedRunKey = (exportId, feedId) => `${exportId}:${feedId}`;

/**
 * Upserts the run-progress doc for a run key. Best-effort: never blocks the run itself.
 * NOTE: `exportId` on the doc IS the run key — a patch must never set it, or the upsert filter
 * stops matching and each progress update spawns a fresh document (feed runs carry the plain
 * category-set id as `setId` instead).
 */
async function setRunProgress(runKey, patch) {
    try {
        await getDb().collection(RUNS_COLLECTION).updateOne(
            { exportId: runKey.toString() },
            { $set: { ...patch, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (e) {
        console.error('Failed to record AI run progress:', e.message);
    }
}

/** Latest categorization run for a run key, or null if it has never run. */
async function getRunStatus(runKey) {
    const run = await getDb().collection(RUNS_COLLECTION).findOne(
        { exportId: runKey.toString() },
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

/* -------------------------------------------------------------------------- */
/*  Own Source feeds — the same categorization over `external_products`         */
/* -------------------------------------------------------------------------- */

const EXTERNAL_COLLECTION = 'external_products';

/** Strips tags/entities from supplier HTML so the model gets prose, not markup. */
function textFromHtml(html) {
    return String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z]+;|&#\d+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Compact prompt view of one feed product. Feed rows carry full supplier `descriptionHtml` and
 * every variant, which would blow the batch payload up for no gain — the category is decided by
 * the name, the supplier's own type/tags and a short description. Sending less also keeps the
 * per-feed AI cost proportional to the catalogue, not to how verbose the supplier is.
 */
function compactFeedProduct(p) {
    return {
        code: p.code,
        product_name: p.product_name,
        vendor: p.vendor || undefined,
        // The supplier's OWN taxonomy is strong evidence — pass it through as context.
        supplier_type: p.categories?.[0] || undefined,
        supplier_tags: p.tags?.length ? p.tags.slice(0, 20) : undefined,
        description: textFromHtml(p.detailed_description).slice(0, 600) || undefined,
        child_products: (p.child_products || []).slice(0, 10).map((v) => ({ code: v.code, size: v.size }))
    };
}

/**
 * Mongo `$expr` for "this row still needs categorizing for `exportId`". A row qualifies when it
 * has no entry for the set at all, or its entry is stale — written against a different
 * `contentHash` (the supplier renamed / re-described / re-tagged it since we last asked).
 * A `manual: true` entry is a partner's own override and is NEVER re-categorized.
 */
function needsCategorizationExpr(exportId) {
    return {
        $not: {
            $in: [true, {
                $map: {
                    input: { $ifNull: ['$ai_categories', []] },
                    as: 'c',
                    in: {
                        $and: [
                            { $eq: ['$$c.exportId', exportId] },
                            {
                                $or: [
                                    { $eq: ['$$c.manual', true] },
                                    { $eq: ['$$c.contentHash', '$contentHash'] }
                                ]
                            }
                        ]
                    }
                }
            }]
        }
    };
}

/**
 * Categorizes ONE Own Source feed against ONE category set, persisting the result on each
 * `external_products` row as an `ai_categories` entry (the same shape Patrik products use, plus
 * the `contentHash` the decision was made against).
 *
 * Incremental by design: only rows that are new or whose content changed since they were last
 * categorized are sent to the model, so a scheduled re-import of an unchanged feed costs nothing.
 *
 * @param {string} feedId  the Own Source feed
 * @param {string} exportId  the category set whose categories the model must choose from
 * @returns {Promise<{feedId: string, exportId: string, productsFound: number, productsCategorized: number}>}
 */
async function identifyFeedProductCategories(feedId, exportId) {
    const runKey = feedRunKey(exportId, feedId);
    try {
        const db = getDb();
        const externalCollection = db.collection(EXTERNAL_COLLECTION);

        const validCategories = await db.collection('categories').find({ exportId: exportId.toString() }).toArray();
        if (validCategories.length === 0) {
            const now = new Date();
            const error = 'No categories defined for this category set — add categories first.';
            await setRunProgress(runKey, {
                status: 'failed', feedId, setId: exportId, error,
                total: 0, processed: 0, categorized: 0, batch: 0, totalBatches: 0, startedAt: now, finishedAt: now
            });
            return { feedId, exportId, productsFound: 0, productsCategorized: 0, error };
        }

        const productsToCategorize = await externalCollection
            .find({ feedId, $expr: needsCategorizationExpr(exportId) })
            .toArray();

        if (productsToCategorize.length === 0) {
            const now = new Date();
            await setRunProgress(runKey, {
                status: 'done', feedId, setId: exportId, error: null,
                total: 0, processed: 0, categorized: 0, batch: 0, totalBatches: 0, startedAt: now, finishedAt: now
            });
            return { feedId, exportId, productsFound: 0, productsCategorized: 0, error: null };
        }

        console.log(`[ai] ${productsToCategorize.length} feed product(s) to categorize for ${runKey}.`);
        const categoriesForPrompt = validCategories.map((c) => ({ id: c._id.toString(), label: c.label }));
        const categoryMap = new Map(categoriesForPrompt.map((c) => [c.id, c.label]));
        const totalBatches = Math.ceil(productsToCategorize.length / BATCH_SIZE);
        let totalCategorized = 0;
        let lastError = null;

        await setRunProgress(runKey, {
            status: 'running', feedId, setId: exportId, error: null,
            total: productsToCategorize.length, processed: 0, categorized: 0,
            batch: 0, totalBatches, startedAt: new Date(), finishedAt: null
        });

        for (let i = 0; i < productsToCategorize.length; i += BATCH_SIZE) {
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const batch = productsToCategorize.slice(i, i + BATCH_SIZE);
            const hashByCode = new Map(batch.map((p) => [p.code, p.contentHash ?? null]));

            const { results: batchResults, error: batchError } = await processBatch(
                batch.map(compactFeedProduct), categoriesForPrompt, runKey
            );
            if (batchError) lastError = batchError;

            // Two ops per product, ORDERED: `$pull` the previous entry for this set, then `$push`
            // the new one. `$addToSet` (the Patrik path) would append a second entry whenever the
            // model changes its mind, which for a re-categorized feed row is the normal case.
            const bulkOps = [];
            for (const result of batchResults) {
                const categoryName = categoryMap.get(String(result.catId));
                if (!categoryName) {
                    console.warn(`[ai] category id ${result.catId} not in set ${exportId} (product ${result.code}) — skipped.`);
                    continue;
                }
                if (!hashByCode.has(result.code)) continue; // model echoed a code we didn't send
                const filter = { feedId, code: result.code };
                bulkOps.push(
                    { updateOne: { filter, update: { $pull: { ai_categories: { exportId } } } } },
                    {
                        updateOne: {
                            filter,
                            update: {
                                $push: {
                                    ai_categories: {
                                        exportId,
                                        categoryId: result.catId,
                                        categoryName,
                                        contentHash: hashByCode.get(result.code),
                                        at: new Date()
                                    }
                                }
                            }
                        }
                    }
                );
            }

            if (bulkOps.length) {
                await externalCollection.bulkWrite(bulkOps, { ordered: true });
                totalCategorized += bulkOps.length / 2;
            }

            await setRunProgress(runKey, {
                batch: batchNum,
                processed: Math.min(i + BATCH_SIZE, productsToCategorize.length),
                categorized: totalCategorized,
                error: lastError
            });
        }

        await setRunProgress(runKey, {
            status: totalCategorized === 0 && lastError ? 'failed' : 'done',
            error: lastError,
            finishedAt: new Date()
        });

        return {
            feedId,
            exportId,
            productsFound: productsToCategorize.length,
            productsCategorized: totalCategorized,
            // Non-null when at least one batch failed. The caller surfaces this on the sync run so
            // "sync finished, but the tags didn't change" is never silent.
            error: lastError
        };
    } catch (error) {
        console.error(`[ai] feed categorization failed for ${runKey}:`, error.message);
        await setRunProgress(runKey, { status: 'failed', error: error.message, finishedAt: new Date() });
        throw error;
    }
}

/**
 * Wrapper used by the Shopify push: brings a feed's categories up to date before its tags are
 * resolved. NEVER throws — a categorization problem must not abort the sync (stock and prices
 * still need to go out, and the push falls back to the feed's own tags). It always REPORTS,
 * though: the returned `error` is recorded on the sync run, because a silent failure here looks
 * exactly like "the sync worked but my tags never updated".
 *
 * @returns {Promise<{productsFound:number, productsCategorized:number, error:string|null}>}
 */
async function ensureFeedCategorized(feedId, exportId) {
    try {
        return await identifyFeedProductCategories(feedId, exportId);
    } catch (e) {
        console.error(`[ai] categorization failed for feed ${feedId}:`, e.message);
        return { feedId, exportId, productsFound: 0, productsCategorized: 0, error: e.message };
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

module.exports = {
    identifyProductCategories,
    identifyFeedProductCategories,
    ensureFeedCategorized,
    getCategoryNameForProductCode,
    categorizeExternalProducts,
    getRunStatus,
    feedRunKey
};