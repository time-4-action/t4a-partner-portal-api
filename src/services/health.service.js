const axios = require('axios');
const { getDb } = require('./db/mongo.service');
const { baseApiUrl, secretKey, companyId, warehouse } = require('../config/metakocka/metakocka');

const HEALTH_TIMEOUT_MS = 5000;

const checkDatabase = async () => {
    try {
        const db = getDb();
        await db.admin().ping();
        return 'ok';
    } catch (error) {
        console.error('Database health check failed:', error.message);
        return 'error';
    }
};

/**
 * Checks PNV reachability by sending a HEAD request to PNV_BASE_URL.
 * Any HTTP response (even 4xx) means the server is up.
 * A network error or timeout means it is unreachable.
 */
const checkPnv = async () => {
    const baseUrl = process.env.PNV_BASE_URL;
    if (!baseUrl) return 'misconfigured';

    try {
        await axios.head(baseUrl, { timeout: HEALTH_TIMEOUT_MS });
        return 'ok';
    } catch (error) {
        // A real HTTP error response still means the server is reachable
        if (error.response) return 'ok';
        console.error('PNV health check failed:', error.message);
        return 'error';
    }
};

/**
 * Checks Metakocka reachability and auth by requesting 1 item from the
 * warehouse stock endpoint. A valid API response (even empty) means ok.
 */
const checkMetakocka = async () => {
    if (!secretKey || !companyId) return 'misconfigured';

    try {
        const response = await axios.post(
            baseApiUrl + warehouse.api.warehouseStock,
            {
                secret_key: secretKey,
                company_id: companyId,
                wh_id_list: warehouse.t4aMainWarehouseId,
                limit: '1',
                offset: '0',
            },
            { timeout: HEALTH_TIMEOUT_MS }
        );

        // Metakocka returns a top-level object on success
        if (response.data && typeof response.data === 'object') return 'ok';
        return 'error';
    } catch (error) {
        console.error('Metakocka health check failed:', error.message);
        return 'error';
    }
};

const checkDependencies = async () => {
    const [database, pnv, metakocka] = await Promise.all([
        checkDatabase(),
        checkPnv(),
        checkMetakocka(),
    ]);

    return { database, pnv, metakocka };
};

module.exports = { checkDependencies };
