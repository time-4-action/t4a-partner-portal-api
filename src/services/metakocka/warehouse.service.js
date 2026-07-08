const axios = require("axios");
const { baseApiUrl, warehouse, secretKey, companyId } = require("../../config/metakocka/metakocka");

/**
 * Free (available-to-sell) amount for a single Metakocka stock row.
 * Metakocka returns `free_amount` (= amount - reserved_amount) only when the company
 * uses reservations; without reservations only `amount` is present, so we fall back to
 * `amount - reserved_amount` (reserved defaults to 0, which reduces to `amount`).
 * @param {{amount?: string|number, reserved_amount?: string|number, free_amount?: string|number}} row
 * @returns {number}
 */
function rowFreeAmount(row) {
    if (row.free_amount != null && row.free_amount !== '') return Number(row.free_amount);
    return Number(row.amount || 0) - Number(row.reserved_amount || 0);
}

/**
 * Fetches all stock for a given warehouse from the Metakocka API.
 * It handles pagination by making multiple requests until all stock is retrieved.
 * The stock is returned as a Map for efficient O(1) lookups by product code.
 *
 * A product can have several stock rows within one warehouse (e.g. one per microlocation),
 * so rows are SUMMED per product code rather than overwritten. The per-code entry carries
 * the summed `free`, `amount` and `reserved` — `free` (available-to-sell) is what callers
 * should use for catalogue stock; `amount`/`reserved` are kept for logging/diagnostics.
 * @param {string} [warehouseId=warehouse.t4aMainWarehouseId] - The ID of the warehouse to get stock for. Defaults to the main T4A warehouse.
 * @returns {Promise<Map<string, {code: string, free: number, amount: number, reserved: number, count_code: string, mk_id: string}>>} A promise that resolves to a Map of stock items, with product codes as keys.
 */
async function getWarehouseStock(warehouseId = warehouse.t4aMainWarehouseId) {
    const limit = 1000;
    let offset = 0;
    const allStock = new Map();
    while (true) {
        const response = await axios.post(baseApiUrl + warehouse.api.warehouseStock, {
            secret_key: secretKey,
            company_id: companyId,
            wh_id_list: warehouseId,
            limit: limit.toString(),
            offset: offset.toString(),
        });

        const stockList = response.data.stock_list || [];

        if (stockList.length === 0) {
            break;
        }

        // Accumulate each stock row into the Map, keyed by product code. Multiple rows for the
        // same code (e.g. different microlocations) are summed — overwriting would drop stock.
        for (const row of stockList) {
            const { code, count_code, mk_id } = row;
            if (!code) continue;
            const existing = allStock.get(code);
            if (existing) {
                existing.free += rowFreeAmount(row);
                existing.amount += Number(row.amount || 0);
                existing.reserved += Number(row.reserved_amount || 0);
            } else {
                allStock.set(code, {
                    code,
                    free: rowFreeAmount(row),
                    amount: Number(row.amount || 0),
                    reserved: Number(row.reserved_amount || 0),
                    count_code,
                    mk_id,
                });
            }
        }
        offset += limit;
    }

    return allStock;
}

/**
 * Finds the stock information for a specific product code within a given stock list.
 * @param {Map<string, {code: string, free: number, amount: number, reserved: number, count_code: string, mk_id: string}>} warehouseStock - The Map of stock items to search through.
 * @param {string} code - The product code to find.
 * @returns {{code: string, free: number, amount: number, reserved: number, count_code: string, mk_id: string}|undefined} The stock item object if found, otherwise undefined.
 */
function getProductStock(warehouseStock, code) {
    return warehouseStock.get(code);
}

/**
 * Finds the FREE (available-to-sell) stock amount for a specific product code — i.e. physical
 * stock minus reservations, summed across all warehouse rows. This is what the catalogue stores
 * so reserved units are not advertised as available.
 * @param {Map<string, {code: string, free: number, amount: number, reserved: number, count_code: string, mk_id: string}>} warehouseStock - The Map of stock items to search through.
 * @param {string} code - The product code to find.
 * @returns {number} The free stock amount if the product is found, otherwise 0.
 */
function getProductStockAmount(warehouseStock, code) {
    const productStock = getProductStock(warehouseStock, code);
    return productStock ? Number(productStock.free) : 0;
}

module.exports = { getWarehouseStock, getProductStock, getProductStockAmount };
