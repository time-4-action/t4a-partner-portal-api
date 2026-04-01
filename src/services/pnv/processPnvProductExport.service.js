/**
 * @file src/services/pnv/processPnvProductExport.service.js
 * @module processPnvProductExportService
 * @description This service is responsible for processing the `products.csv` file downloaded from the PNV system.
 *              It parses the CSV data, transforms it into a structured JSON format, enriches it with data
 *              from other services (like Metakocka for stock and pricing), and finally synchronizes the
 *              resulting product data with the MongoDB database.
 */
const { productMapping } = require("../../config/pnv/products")
const { parse } = require('csv-parse');
const { getProductPricelist } = require("../metakocka/price.service");
const { getWarehouseStock, getProductStockAmount } = require("../metakocka/warehouse.service");
const { monitorFunction } = require('../analytics.service');
const fs = require('fs');
const { getDb } = require('../db/mongo.service');
const path = require('path');

/**
 * Reads and parses the `products.csv` file from the local filesystem.
 * The file is expected to be semicolon-delimited and contain a byte order mark (BOM),
 * which is handled by the `bom: true` option.
 *
 * @function parseProductsCsv
 * @returns {Promise<Array<Object>>} A promise that resolves with an array of raw product objects from the CSV, where keys are the CSV headers.
 * @throws {Error} If the CSV file is not found at the expected path.
 */
const parseProductsCsv = () => {
    return new Promise((resolve, reject) => {
        const pnvDataDir = path.resolve(process.env.DATA_PATH || path.join(__dirname, '..', '..', '..', 'data'), 'pnv');
        const csvFilePath = path.join(pnvDataDir, "products.csv");

        if (!fs.existsSync(csvFilePath)) {
            return reject(new Error(`CSV file not found at: ${csvFilePath}`));
        }

        const products = [];
        const parser = parse({
            columns: true,  // Treat the first line as headers
            delimiter: ';', // Use semicolon as the field separator
            trim: true,     // Trim whitespace from headers and values
            bom: true,      // Handle potential byte order mark at the start of the file
        });

        const stream = fs.createReadStream(csvFilePath);
        stream.pipe(parser);

        parser.on('data', (row) => {
            products.push(row);
        });

        parser.on('end', () => {
            resolve(products);
        });

        parser.on('error', (err) => {
            reject(err);
        });
    });
};

/**
 * Transforms a single raw product object from the CSV into a structured JSON object, enriching it with external data.
 *
 * This function performs several key operations:
 * 1.  Applies the declarative `columnMapping` to transform CSV columns to JSON keys. It supports direct mapping, array mapping (multiple columns to one array), and custom transform functions.
 * 2.  Enriches the product data by fetching its stock amount from the Metakocka warehouse service.
 * 3.  Enriches the product data further by fetching its pricelist from the Metakocka price service.
 *
 * Each external service call is monitored for performance and errors.
 *
 * @async
 * @function mapProduct
 * @param {Object} product - The raw product object from the parsed CSV.
 * @param {Array<Object>} columnMapping - The mapping configuration that defines how to transform the raw data.
 * @param {Map<string, Object>} warehouseStock - A Map of all warehouse stock items, used for efficient O(1) stock lookups.
 * @returns {Promise<Object>} A promise that resolves to the fully mapped and enriched product JSON object.
 */
const mapProduct = async (product, columnMapping, warehouseStock) => {
    const productJson = {};
    for (const mapping of columnMapping) {
        // Case 1: Direct mapping from a single CSV header to a single JSON key.
        if (mapping.csvHeader) {
            const { csvHeader, jsonKey, transform } = mapping;
            const value = product[csvHeader];

            if (transform && typeof transform === 'function') {
                productJson[jsonKey] = await transform(value, product);
            } else {
                productJson[jsonKey] = value;
            }
        }
        // Case 2: Mapping multiple CSV headers (e.g., 'Image1', 'Image2') into a single array under one JSON key.
        else if (mapping.csvHeaders) {
            const { csvHeaders, jsonKey, transform } = mapping;
            const values = csvHeaders
                .map(header => product[header])
                .filter(value => value !== undefined && value !== ''); // Filter out empty or undefined image links

            if (transform && typeof transform === 'function') {
                productJson[jsonKey] = await transform(values, product);
            } else {
                productJson[jsonKey] = values;
            }
        }
        // Case 3: Generating a field programmatically using a transform function, without direct CSV input.
        else if (mapping.jsonKey && mapping.transform) {
            const { jsonKey, transform } = mapping;
            productJson[jsonKey] = await transform(undefined, product);
        }
    }

    // Enrich the product with its current stock amount from Metakocka.
    productJson.stock_amount = await monitorFunction(
        () => getProductStockAmount(warehouseStock, product.Code),
        'getProductStockAmount'
    );

    // Enrich the product with its pricelist information from Metakocka.
    productJson.pricelist = await monitorFunction(
        () => getProductPricelist(product.Code),
        'getProductPricelist',
        { code: product.Code }
    );

    return productJson;
};

/**
 * The main orchestrator function for processing the PNV product export.
 *
 * This function performs the following high-level steps:
 * 1.  Fetches all warehouse stock data from Metakocka to be used for enrichment. This is done once per run for efficiency.
 * 2.  Parses the locally stored `products.csv` file.
 * 3.  Processes the raw product list to build a parent-child hierarchy. It groups all product variants (children) under their main product (parent).
 * 4.  Maps all parent products and their attached children into the final JSON structure, enriching them with stock and price data along the way.
 * 5.  Synchronizes the data with the MongoDB `products` collection:
 *     - It marks any products currently in the DB but not in the new CSV as `active: false`.
 *     - It performs a bulk `upsert` operation to efficiently create new products and update existing ones.
 *
 * @async
 * @function processPnvProductExport
 * @param {Array<Object>} [columnMapping=productMapping] - The column mapping configuration. Defaults to the one from `src/config/pnv/products.js`.
 * @returns {Promise<Array<Object>>} A promise that resolves with an array of the final parent product data that was synced to the database.
 * @throws {Error} If the column mapping is invalid or if any critical step (like parsing or DB connection) fails.
 */
const processPnvProductExport = async (columnMapping = productMapping) => {
    try {
        if (!columnMapping || !Array.isArray(columnMapping) || columnMapping.length === 0) {
            throw new Error('A valid columnMapping array must be provided to processPnvProductExport.');
        }

        // Step 1: Pre-fetch all warehouse stock from Metakocka.
        // This is done once to avoid making a network request for every single product, significantly improving performance.
        const warehouseStock = await monitorFunction(
            () => getWarehouseStock(),
            'getWarehouseStock'
        );

        // Step 2: Parse the raw product data from the CSV file.
        const allProducts = await parseProductsCsv();
        const parentProductCodeColumn = 'Koda nadprodukta';
        const productCodeColumn = 'Code';

        // Step 3: Group all child products (variants) by their parent's product code.
        // This creates a lookup map where each key is a parent code and the value is an array of its mapped children.
        const childrenByParentCode = {};
        for (const product of allProducts) {
            const parentCode = product[parentProductCodeColumn];
            if (parentCode) {
                if (!childrenByParentCode[parentCode]) {
                    childrenByParentCode[parentCode] = [];
                }
                // Map the child product into its final JSON structure before adding it to the group.
                childrenByParentCode[parentCode].push(await mapProduct(product, columnMapping, warehouseStock));
            }
        }

        // Step 4: Process only the parent products and attach their children.
        // A product is considered a parent if it does not have a 'Koda nadprodukta'.
        const parentProductsData = [];
        for (const product of allProducts) {
            if (!product[parentProductCodeColumn]) {
                // Map the parent product to its final JSON structure.
                const mappedProduct = await mapProduct(product, columnMapping, warehouseStock);
                // Attach the array of children (if any) from the lookup map created in Step 3.
                mappedProduct.child_products = childrenByParentCode[product[productCodeColumn]] || [];
                parentProductsData.push(mappedProduct);
            }
        }

        // Step 5: Synchronize the processed data with the MongoDB database.
        console.log('Syncing products to MongoDB...');
        const db = getDb();
        const productsCollection = db.collection('products');

        // Create a Set of all product codes from the incoming CSV for efficient lookup.
        const allIncomingCodes = new Set(parentProductsData.map(p => p.code));

        // Step 5a: Deactivate products that exist in the database but are NOT in the latest CSV sync.
        const updateResult = await productsCollection.updateMany(
            { code: { $nin: Array.from(allIncomingCodes) }, active: { $ne: false } },
            { $set: { active: false, updatedAt: new Date() } }
        );

        if (updateResult.modifiedCount > 0) {
            console.log(`Marked ${updateResult.modifiedCount} products as inactive.`);
        }

        // Step 5b: Perform a bulk write operation to insert new products and update existing ones.
        let created = 0;
        let updated = 0;

        if (parentProductsData.length > 0) {
            const bulkOps = parentProductsData.map(product => ({
                updateOne: {
                    filter: { code: product.code },
                    update: {
                        $set: { ...product, active: true, updatedAt: new Date() },
                        $setOnInsert: { createdAt: new Date() }
                    },
                    upsert: true
                }
            }));

            const bulkResult = await productsCollection.bulkWrite(bulkOps);
            created = bulkResult.upsertedCount;
            updated = bulkResult.modifiedCount;
            console.log(`Successfully synced products to MongoDB.`);
            console.log(`- ${created} products created.`);
            console.log(`- ${updated} products updated.`);
        } else {
            console.log('No products to sync.');
        }

        return {
            totalProcessed: parentProductsData.length,
            created,
            updated,
            deactivated: updateResult.modifiedCount,
        };

    } catch (error) {
        console.error("Error processing products to JSON:", error);
        // Re-throwing the error is good practice if the caller needs to handle it
        throw error;
    }
};

module.exports = { processPnvProductExport };