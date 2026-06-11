/**
 * @file src/services/pnv/pnvProductsSync.service.js
 * @module pnvProductsSyncService
 * @description This service orchestrates the process of synchronizing product data from the PNV (Partner.net Vision) system.
 *              It handles authentication, triggers the export on the PNV side, downloads the resulting CSV file,
 *              and then initiates the processing and database insertion of the product data.
 */
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { processPnvProductExport } = require('./processPnvProductExport.service');
const { monitorFunction } = require('../analytics.service');


/**
 * Creates the authentication cookie string required for PNV API requests by hashing the password.
 * @returns {string} The complete authentication cookie string (e.g., "pnv_cms_2_user=...; pnv_cms_2_pass=...;").
 * @throws {Error} If any of the required PNV environment variables (PNV_USER, PNV_PASS, PNV_GROUP, PNV_USER_ID) are not set.
 */
const getAuthCookie = () => {
    const user = process.env.PNV_USER;
    const pass = process.env.PNV_PASS;
    const group = process.env.PNV_GROUP;
    const userId = process.env.PNV_USER_ID;

    if (!user || !pass || !group || !userId) {
        throw new Error('PNV_USER, PNV_PASS, PNV_GROUP, and PNV_USER_ID must be set in the environment variables.');
    }

    // SECURITY: SHA1 is used here because it is required by the legacy PNV system.
    // This is not a security risk in this context as we are the client communicating with their API.
    const passHash = crypto.createHash('sha1').update(pass).digest('hex');
    return `pnv_cms_2_user=${user}; pnv_cms_2_pass=${passHash}; pnv_cms_2_group=${group}; pnv_cms_2_user_id=${userId}`;
};

/**
 * Triggers the generation of a products export file on the PNV server and fetches the resulting download link.
 * This function sends a POST request that initiates an asynchronous task on the remote server to create the file.
 *
 * @async
 * @param {string} cookie - The authentication cookie obtained from `getAuthCookie`.
 * @returns {Promise<string>} A promise that resolves to the relative URL path of the generated download file (e.g., "some/path/products.csv").
 * @throws {Error} If the API request fails, times out, or if the response does not contain the expected 'download_link' field.
 */
const fetchPnvDownloadLink = async (cookie) => {
    const exportUrl = process.env.PNV_EXPORT_PRODUCTS_URL;
    if (!exportUrl) {
        throw new Error('PNV_EXPORT_PRODUCTS_URL must be set in the environment variables.');
    }

    try {
        const response = await axios.post(exportUrl, new URLSearchParams(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Accept-Language': 'en-US,en;q=0.7',
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': cookie,
            }
        });
        const downloadLink = response.data.download_link;
        if (!downloadLink) {
            throw new Error(`'download_link' not found in API response. Response data: ${JSON.stringify(response.data)}`);
        }
        return downloadLink;
    } catch (error) {
        console.error('Error fetching download link:', error.message);
        throw error; // Re-throw to be handled by the caller
    }
};

/**
 * Downloads a file from a given URL using a streaming approach and saves it to a specified path.
 *
 * @async
 * @param {string} fileUrl - The full, absolute URL of the file to download.
 * @param {string} savePath - The local file path where the downloaded file should be saved (e.g., "/path/to/data/products.csv").
 * @param {string} cookie - The authentication cookie required to access the download URL.
 * @returns {Promise<void>} A promise that resolves when the file has been successfully downloaded and saved.
 * @throws {Error} If the file download or local save operation fails.
 */
const downloadFile = async (fileUrl, savePath, cookie) => {
    const writer = require('fs').createWriteStream(savePath);

    const response = await axios.get(fileUrl, {
        headers: { 'Cookie': cookie },
        responseType: 'stream',
    });

    // Use pipeline to efficiently stream the download directly to the file, handling backpressure and errors.
    await pipeline(response.data, writer);
};

/**
 * Orchestrates the entire process of downloading and processing the PNV products export.
 *
 * This is the main function of the service. It performs the following steps:
 * 1.  Validates that the necessary PNV base URL is configured.
 * 2.  Generates the required authentication cookie for the PNV API.
 * 3.  Triggers the product export file generation on the PNV server and fetches the download link.
 * 4.  Constructs the full URL for the file and defines the local save path.
 * 5.  Downloads the product CSV file to the local filesystem.
 * 6.  Triggers the `processPnvProductExport` service to parse the CSV, transform the data, and sync it with the MongoDB database.
 *
 * Each major step is wrapped in `monitorFunction` for performance and error tracking.
 *
 * @async
 * @function runPnvProductSync
 * @returns {Promise<void>} A promise that resolves when the entire sync process is complete.
 * @throws {Error} Throws an error if critical environment variables are missing or if any step in the process fails.
 */
const runPnvProductSync = async () => {
    try {
        // Ensure the base URL for the PNV system is available.
        const baseUrl = process.env.PNV_BASE_URL;
        if (!baseUrl) {
            throw new Error('PNV_BASE_URL must be set in the environment variables.');
        }

        // Step 1: Authenticate and get the session cookie required for all subsequent API calls.
        console.log('[pnv-sync] authenticating with PNV…');
        const cookie = getAuthCookie();

        // Step 2: Request the PNV server to generate a new product export file and return its download link.
        console.log('[pnv-sync] requesting export file generation…');
        const downloadLink = await monitorFunction(
            () => fetchPnvDownloadLink(cookie),
            'fetchPnvDownloadLink'
        );

        // Step 3: Prepare for file download.
        const fileUrl = `${baseUrl}/${downloadLink}`;
        const fileName = 'products.csv';

        // Define the local directory and path for saving the downloaded CSV file.
        // This path is resolved relative to the project root's 'data' directory.
        const saveDir = path.resolve(process.env.DATA_PATH || path.join(__dirname, '..', '..', '..', 'data'), 'pnv');
        const savePath = path.join(saveDir, fileName);

        // Ensure the target directory exists before attempting to write the file.
        await fs.mkdir(saveDir, { recursive: true });

        // Step 4: Download the file from the PNV server to the local path.
        console.log(`[pnv-sync] downloading products CSV → ${savePath}`);
        const dlMs = Date.now();
        await downloadFile(fileUrl, savePath, cookie);
        try {
            const { size } = await fs.stat(savePath);
            console.log(`[pnv-sync] download complete in ${((Date.now() - dlMs) / 1000).toFixed(1)}s — ${(size / 1024 / 1024).toFixed(2)} MB`);
        } catch {
            console.log(`[pnv-sync] download complete in ${((Date.now() - dlMs) / 1000).toFixed(1)}s`);
        }

        // Step 5: After a successful download, trigger the service to process the CSV file and sync with the DB.
        console.log('[pnv-sync] parsing CSV + Metakocka enrichment + DB upsert…');
        const procMs = Date.now();
        const stats = await monitorFunction(
            () => processPnvProductExport(),
            'processPnvProductExport'
        );
        console.log(`[pnv-sync] processing complete in ${((Date.now() - procMs) / 1000).toFixed(1)}s`);

        return stats;

    } catch (error) {
        console.error('Failed to complete product download process:', error.message);
        throw error;
    }
};

module.exports = { runPnvProductSync };