const { graphqlRequest } = require('./shopifyGraphql.service');

/**
 * SKU → Shopify-variant matching (design §7).
 *
 * Resolves our `child_products[].code` (SKU) and, as a fallback, `ean_code` (barcode)
 * against the variants that already exist in a partner's store, using the GraphQL
 * `productVariants(query:)` search. Phase A is **stock-only**, so this never creates
 * products — anything that can't be matched is returned for the "needs attention" report.
 *
 * Matching rules applied per identifier:
 *   - exactly one variant whose field equals the value  → matched
 *   - zero matches                                       → unmatched (caller may try barcode)
 *   - more than one match                                → ambiguous (duplicate in store), skipped
 *
 * Equality is checked in code against the exact value because Shopify's search is
 * prefix/loose for some fields; we only accept an exact, unique hit.
 */

const VARIANTS_BY_FIELD_QUERY = `query VariantsByField($query: String!, $cursor: String) {
  productVariants(first: 100, query: $query, after: $cursor) {
    edges {
      node {
        id
        sku
        barcode
        inventoryItem { id }
        product { id }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Max identifiers OR-ed into a single search query (keeps the query string bounded). */
const BATCH_SIZE = 30;

const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

/** Escapes a value for use inside a single-quoted Shopify search term. */
const escapeTerm = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Looks up variants for a set of identifier values on one field ('sku' | 'barcode'),
 * paginating each batch fully. Returns a Map: value → array of matching variant nodes
 * (array length > 1 signals a duplicate in the store).
 *
 * @param {string} shop
 * @param {string} accessToken
 * @param {'sku'|'barcode'} field
 * @param {string[]} values - already de-duplicated, non-empty
 * @returns {Promise<Map<string, Array<{id,sku,barcode,inventoryItem:{id},product:{id}}>>>}
 */
async function lookupByField(shop, accessToken, field, values) {
    const byValue = new Map();
    for (const value of values) byValue.set(value, []);

    for (const group of chunk(values, BATCH_SIZE)) {
        const queryStr = group.map((v) => `${field}:'${escapeTerm(v)}'`).join(' OR ');
        let cursor = null;
        // Paginate so a batch that matches >100 variants (many duplicates) is never truncated.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const data = await graphqlRequest(shop, accessToken, VARIANTS_BY_FIELD_QUERY, { query: queryStr, cursor });
            const conn = data?.productVariants;
            for (const edge of conn?.edges || []) {
                const node = edge.node;
                const key = node?.[field];
                // Only keep exact-equality hits we actually asked for.
                if (key != null && byValue.has(key)) byValue.get(key).push(node);
            }
            if (conn?.pageInfo?.hasNextPage) cursor = conn.pageInfo.endCursor;
            else break;
        }
    }
    return byValue;
}

/**
 * Resolves a list of variant identifiers against the store. SKU is the primary key;
 * anything not uniquely matched by SKU is retried by barcode.
 *
 * @param {string} shop
 * @param {string} accessToken
 * @param {Array<{sku:string, barcode?:string|null}>} identifiers - the SKUs to resolve
 * @returns {Promise<Map<string, { node:Object|null, reason:string|null }>>}
 *   keyed by SKU. `node` set when uniquely matched; otherwise `reason` explains why not.
 */
async function matchVariants(shop, accessToken, identifiers) {
    const result = new Map();
    const skus = [...new Set(identifiers.map((i) => i.sku).filter(Boolean))];
    if (!skus.length) return result;

    const bySku = await lookupByField(shop, accessToken, 'sku', skus);

    const needBarcode = [];
    for (const ident of identifiers) {
        const hits = bySku.get(ident.sku) || [];
        if (hits.length === 1) {
            result.set(ident.sku, { node: hits[0], reason: null, matchedOn: 'sku' });
        } else if (hits.length > 1) {
            result.set(ident.sku, { node: null, reason: 'Duplicate SKU found in store' });
        } else if (ident.barcode) {
            needBarcode.push(ident);
        } else {
            result.set(ident.sku, { node: null, reason: 'No SKU / barcode match in store' });
        }
    }

    if (needBarcode.length) {
        const barcodes = [...new Set(needBarcode.map((i) => i.barcode).filter(Boolean))];
        const byBarcode = await lookupByField(shop, accessToken, 'barcode', barcodes);
        for (const ident of needBarcode) {
            const hits = byBarcode.get(ident.barcode) || [];
            if (hits.length === 1) {
                result.set(ident.sku, { node: hits[0], reason: null, matchedOn: 'barcode' });
            } else if (hits.length > 1) {
                result.set(ident.sku, { node: null, reason: 'Duplicate barcode found in store' });
            } else {
                result.set(ident.sku, { node: null, reason: 'No SKU / barcode match in store' });
            }
        }
    }

    return result;
}

module.exports = { matchVariants, _internals: { escapeTerm, lookupByField } };
