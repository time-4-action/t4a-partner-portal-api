/**
 * @file src/jobs/pnv/pnvProductsSync.job.js
 * @description This file defines the main job for synchronizing products from the PNV system
 *              and subsequently running AI-powered category identification on them.
 */

const { runPnvProductSync } = require('../../services/pnv/pnvProductsSync.service');
const { identifyProductCategories } = require('../../services/ai/categoryIdentification.service');
const { monitorFunction } = require('../../services/analytics.service');
const { getAiEnabledExports } = require("../../services/exports.service");

/**
 * Orchestrates the complete product synchronization and categorization process.
 *
 * This job performs the following steps in sequence:
 * 1.  **Product Synchronization**: It calls `runPnvProductSync` to download the latest product data from the PNV system, process it, and save it to the database. This step is monitored for performance and errors.
 * 2.  **AI Categorization**: It retrieves all "exports" that are enabled for AI categorization.
 * 3.  **Iterate and Categorize**: For each AI-enabled export, it invokes the `identifyProductCategories` service to categorize any new or uncategorized products. This step is also monitored.
 *
 * @async
 * @function pnvProductSyncJob
 * @returns {Promise<void>} A promise that resolves when the entire synchronization and categorization process is complete.
 */
const pnvProductSyncJob = async () => {
    // Step 1: Run the core product synchronization from the PNV system.
    // This includes downloading the CSV, processing products, and saving them to the database.
    await monitorFunction(
        () => runPnvProductSync(),
        'runPnvProductSync'
    );

    // Step 2: Fetch all export configurations that are enabled for AI-driven category identification.
    const aiEnabledExports = await getAiEnabledExports();

    // Step 3: Loop through each enabled export and run the AI categorization service.
    for (const _export of aiEnabledExports) {
        // The service will find any new products for this exportId and use AI to assign a category.
        await monitorFunction(
            () => identifyProductCategories(_export._id.toString()),
            'identifyProductCategories'
        );
    }
}

module.exports = {
    pnvProductSyncJob
}