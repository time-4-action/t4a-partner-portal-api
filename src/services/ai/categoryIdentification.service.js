const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { getDb } = require('../db/mongo.service');
const { ObjectId } = require('mongodb');
const { logAiUsage } = require('./analytics.service');

const API_KEY = process.env.GOOGLE_API_KEY;
if (!API_KEY) {
    throw new Error('GOOGLE_API_KEY must be set in environment variables.');
}
const genAI = new GoogleGenerativeAI(API_KEY);

const MODEL_NAME = 'gemini-2.5-flash';
const BATCH_SIZE = 30;

const responseSchema = {
    type: SchemaType.OBJECT,
    properties: {
        results: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    code: { type: SchemaType.STRING },
                    catId: { type: SchemaType.STRING }
                },
                required: ["code", "catId"]
            }
        }
    },
    required: ["results"]
};

/**
 * Processes a batch of products to identify their categories using the Generative AI model.
 * @param {Array<Object>} products - The batch of products to categorize.
 * @param {Array<{id: number, label: string}>} validCategories - The list of valid categories for the AI to choose from.
 * @param {string} exportId - The identifier for the category export (e.g., 'tris').
 * @returns {Promise<Array<{code: string, catId: number}>>} A promise that resolves with the categorized results.
 */
async function processBatch(products, validCategories, exportId) {
    try {
        const model = genAI.getGenerativeModel({
            model: MODEL_NAME,
            systemInstruction: `You are a Product Mapping Assistant. 
            You will be given a list of products. Some products may have a 'child_products' array which represent product variants.
            Use the information in 'child_products' to get more context about the parent product, but ONLY return a category for the parent product.
            Do NOT categorize items inside the 'child_products' array.
            Map each parent product to the most specific and correct category ID from this list: ${JSON.stringify(validCategories)}. 
            If you are unsure, use the ID for "Ostalo" or a similar general category if available.`,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema,
            },
        });

        const inputData = [...products];
        const prompt = `Categorize these products: ${JSON.stringify(inputData)}`;

        const result = await model.generateContent(prompt);

        // Log AI usage analytics
        logAiUsage(exportId, result.response.usageMetadata, MODEL_NAME);

        const jsonResponse = JSON.parse(result.response.text());
        return jsonResponse.results || [];

    } catch (error) {
        console.error('Batch Error:', error.message);
        // Log the full error for more details in case of API issues
        if (error.response) {
            console.error('API Response:', JSON.stringify(error.response.data, null, 2));
        }
        return [];
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
            return { exportId, productsFound: 0, productsCategorized: 0 };
        }

        // 2. Find products that do NOT have a category for this exportId yet
        const productsToCategorize = await productsCollection.find({
            'ai_categories.exportId': { $ne: exportId }
        }).toArray();

        if (productsToCategorize.length === 0) {
            console.log(`No new products to categorize for exportId "${exportId}". All products are up to date.`);
            return { exportId, productsFound: 0, productsCategorized: 0 };
        }

        console.log(`Found ${productsToCategorize.length} new products to categorize for exportId "${exportId}".`);
        const categoriesForPrompt = validCategories.map(c => ({ id: c._id.toString(), label: c.label }));
        const categoryMap = new Map(categoriesForPrompt.map(c => [c.id, c.label]));
        const totalBatches = Math.ceil(productsToCategorize.length / BATCH_SIZE);
        let totalCategorized = 0;

        for (let i = 0; i < productsToCategorize.length; i += BATCH_SIZE) {
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const batch = productsToCategorize.slice(i, i + BATCH_SIZE);
            console.log(`Processing batch ${batchNum}/${totalBatches} for exportId "${exportId}"...`);

            const batchResults = await processBatch(batch, categoriesForPrompt, exportId);

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
        }

        return {
            exportId,
            productsFound: productsToCategorize.length,
            productsCategorized: totalCategorized,
        };

    } catch (error) {
        console.error(`Orchestrator Error for exportId "${exportId}":`, error.message);
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

module.exports = { identifyProductCategories, getCategoryNameForProductCode };