const crypto = require('crypto');
const { getDb } = require('../db/mongo.service');
const { getValidAccessToken } = require('./shopifyToken.service');
const connectionService = require('./shopifyConnection.service');
const { getExportConfigById, applyFilters, getPriceFromPriority, resolveTagsArray } = require('../customExport.service');
const { matchVariants } = require('./shopifyMatch.service');
const productMap = require('./shopifyProductMap.service');
const syncJobs = require('./shopifySyncJobs.service');
const queue = require('./shopifyQueue.service');
const { graphqlRequest } = require('./shopifyGraphql.service');

/**
 * Stock-only sync engine — Phase A (design §8, plan Phase A).
 *
 * The safest, highest-value slice: it pushes **inventory quantities only** to the partner's
 * store and never touches product content, so it can't damage a listing and sidesteps the
 * price/VAT questions entirely. A wrong stock number self-heals on the next run.
 *
 * Pipeline per run:
 *   1. Load the connection (+ decrypted token) and its chosen export config.
 *   2. Build the in-scope inventory items — the SAME published-only narrowing + filters the
 *      exports use ({@link applyFilters}), one item per sellable SKU.
 *   3. Match unmapped SKUs against the store (SKU → barcode); the map is authoritative once
 *      written, so already-mapped SKUs skip the lookup.
 *   4. Push `inventorySetQuantities` to the connection's location, batched + throttle-aware.
 *   5. Record per-SKU map state, an unmatched "needs attention" list, and run counts.
 *
 * Runs are serialized per shop ({@link module:shopifyQueue.service}) so two never race.
 */

const PRODUCTS_COLLECTION = 'products';
const PORTAL_APP_NS = 'gid://t4a-partner-portal';

/** Shopify caps `inventorySetQuantities` at 250 quantities; stay well under for safety. */
const QUANTITIES_PER_CALL = 100;

const INVENTORY_SET_MUTATION = `mutation InventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { id }
    userErrors { code field message }
  }
}`;

// Phase C — content/price push (only in `portal_authoritative` ownership).
const VARIANTS_PRICE_MUTATION = `mutation VariantsPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

const PRODUCT_UPDATE_MUTATION = `mutation ProductUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id }
    userErrors { field message }
  }
}`;

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
};

/**
 * Resolves the connection's export config into the in-scope catalogue: the published-only,
 * filtered products ({@link applyFilters}) AND the flat list of sellable inventory items
 * derived from them (one per variant, or the parent for no-variant products — design §3.4;
 * SKU-less / duplicate SKUs dropped).
 *
 * Returns both so the stock path (items) and the Phase C content/price path (products) share
 * one DB read and one filter pass.
 *
 * @returns {Promise<{ products: Object[], items: Array<{ parentCode:string,
 *   variantCode:string|null, sku:string, barcode:string|null, quantity:number }> }>}
 */
async function buildScope(config) {
    const db = getDb();
    const products = await db.collection(PRODUCTS_COLLECTION).find({ active: true }).toArray();
    const filtered = applyFilters(products, config.filters || {}, config.pricelistPriority || []);

    const items = [];
    const seen = new Set();
    for (const product of filtered) {
        const variants = product.child_products || [];
        const rows = variants.length
            ? variants.map((v) => ({
                  parentCode: product.code,
                  variantCode: v.code || null,
                  sku: v.code || '',
                  barcode: v.ean_code || null,
                  quantity: v.stock_amount || 0
              }))
            : [{
                  parentCode: product.code,
                  variantCode: null,
                  sku: product.code || '',
                  barcode: product.ean_code || null,
                  quantity: product.stock_amount || 0
              }];
        for (const row of rows) {
            // Drop SKU-less rows and collapse any accidental duplicate SKU within our own
            // catalogue (first wins) — pushing the same inventory item twice is pointless.
            if (!row.sku || seen.has(row.sku)) continue;
            seen.add(row.sku);
            items.push(row);
        }
    }
    return { products: filtered, items };
}

/**
 * Resolves the single price to push for a variant: picks the winning pricelist via the
 * connection's priority (reusing {@link getPriceFromPriority}), optionally dropping
 * future-dated lists first (Q5 guard), then applies the VAT mode (Q4).
 *
 * `pricelist[].price` is the NET (ex-VAT) figure — matching the existing exports, where
 * "Price" is net and "Price with VAT" = net × (1 + vat/100). So:
 *   - `inclusive` → push the gross price  (net × (1 + vat/100))
 *   - `exclusive` → push the net price    (as stored)
 *
 * @returns {string|null} price as a 2-dp string, or null when nothing resolvable
 */
function resolvePushPrice(variant, pricelistPriority, vatMode, futureGuard, nowMs) {
    let v = variant;
    if (futureGuard && Array.isArray(variant.pricelist)) {
        v = { ...variant, pricelist: variant.pricelist.filter((pl) => !pl.valid_from || new Date(pl.valid_from).getTime() <= nowMs) };
    }
    const r = getPriceFromPriority(v, pricelistPriority);
    if (!r || !r.price) return null;
    const price = vatMode === 'inclusive' ? r.price * (1 + (r.vat || 0) / 100) : r.price;
    return price.toFixed(2);
}

/**
 * Pushes one batch of inventory quantities. Returns a per-SKU outcome map so the caller can
 * record map state. Never throws — a failed batch marks its own SKUs as errored and is
 * reported, so it can't take down sibling batches (design §8.6).
 *
 * @returns {Promise<Map<string, { ok:boolean, error:string|null }>>}
 */
async function pushBatch(shop, token, locationId, jobId, batch) {
    const outcomes = new Map();
    const quantities = batch.map((it) => ({
        inventoryItemId: it.shopifyInventoryItemId,
        locationId,
        quantity: it.quantity,
        // `changeFromQuantity` is mandatory on 2026-04 (must be present even if null). null
        // skips the compare-and-swap check — correct here: the portal is the source of truth
        // and overwrites absolute quantities. (Replaces the removed `ignoreCompareQuantity`.)
        changeFromQuantity: null
    }));
    const input = {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: `${PORTAL_APP_NS}/SyncJob/${jobId}`,
        quantities
    };
    // Stable per (run, batch) so the throttle-retry inside graphqlRequest is deduplicated by
    // Shopify rather than re-applied. A fresh run gets a fresh key (a new logical write).
    const idempotencyKey = crypto.randomUUID();

    try {
        const data = await graphqlRequest(shop, token, INVENTORY_SET_MUTATION, { input, idempotencyKey });
        const userErrors = data?.inventorySetQuantities?.userErrors || [];
        // Map any per-item userError back to its SKU via the numeric index in the field path
        // (e.g. ["input","quantities","3","quantity"]). Errors without an index taint the batch.
        const erroredIdx = new Map();
        let batchLevelError = null;
        for (const ue of userErrors) {
            const idxSeg = (ue.field || []).find((f) => /^\d+$/.test(f));
            if (idxSeg != null) erroredIdx.set(Number(idxSeg), ue.message);
            else batchLevelError = ue.message;
        }
        batch.forEach((it, i) => {
            const err = erroredIdx.get(i) || batchLevelError;
            outcomes.set(it.sku, { ok: !err, error: err || null });
        });
    } catch (err) {
        // Transport/GraphQL/throttle-exhausted failure — whole batch errored, surface once.
        for (const it of batch) outcomes.set(it.sku, { ok: false, error: err.message });
    }
    return outcomes;
}

/**
 * Phase C — pushes variant prices and product content for MATCHED products, in
 * `portal_authoritative` mode only. Per the ownership contract (design §9) the portal
 * overwrites the fields it manages (price, title, description, tags) on every sync.
 *
 * Delta-gated: a per-variant `priceHash` and a per-product `contentHash` (stored on the map
 * rows) let unchanged products skip the API call entirely. A failed product never blocks the
 * rest; failures are reported and the hash is NOT advanced, so the next run retries.
 *
 * Mutates `counts` (pricesPushed / contentPushed / failed) and appends to `errors`.
 */
async function pushPortalAuthoritative({ connection, token, scopedProducts, matchInfoBySku, existingMap, exportConfig, counts, errors }) {
    const cfg = connection.config || {};
    const wantPrices = !!cfg.syncPrices;
    const wantContent = !!cfg.syncDescriptions;
    if (!wantPrices && !wantContent) return;

    const vatMode = cfg.priceVatMode || 'inclusive';
    const futureGuard = cfg.futureDatedGuard !== false;
    const pricelistPriority = cfg.pricelistPriority || [];
    const nowMs = Date.now();
    const shop = connection.shopDomain;

    const priceOps = []; // { parentCode, productId, variants:[{id,price}], hashes:[{sku,priceHash}] }
    const contentOps = []; // { parentCode, product:{id,title,descriptionHtml,tags}, skus:[], contentHash }

    for (const product of scopedProducts) {
        const variants = product.child_products || [];
        const variantList = variants.length ? variants : [product];
        const matched = variantList
            .map((v) => {
                const sku = (variants.length ? v.code : product.code) || '';
                return { v, sku, info: matchInfoBySku.get(sku) };
            })
            .filter((x) => x.sku && x.info && x.info.shopifyVariantId);
        if (!matched.length) continue;
        const productId = matched[0].info.shopifyProductId;
        if (!productId) continue;

        if (wantPrices) {
            const variantUpdates = [];
            const hashes = [];
            for (const { v, sku, info } of matched) {
                const price = resolvePushPrice(v, pricelistPriority, vatMode, futureGuard, nowMs);
                if (price == null) continue; // nothing resolvable — leave the variant's price alone
                const priceHash = sha1(price);
                if (existingMap.get(sku)?.priceHash === priceHash) continue; // delta: unchanged
                variantUpdates.push({ id: info.shopifyVariantId, price });
                hashes.push({ sku, priceHash });
            }
            if (variantUpdates.length) priceOps.push({ parentCode: product.code, productId, variants: variantUpdates, hashes });
        }

        if (wantContent) {
            const title = product.product_name || '';
            const descriptionHtml = product.detailed_description || product.short_description || '';
            const tags = resolveTagsArray(product, exportConfig) || [];
            const contentHash = sha1(JSON.stringify({ title, descriptionHtml, tags }));
            if (existingMap.get(matched[0].sku)?.contentHash !== contentHash) {
                contentOps.push({ parentCode: product.code, product: { id: productId, title, descriptionHtml, tags }, skus: matched.map((m) => m.sku), contentHash });
            }
        }
    }

    const hashUpdates = [];

    await queue.mapWithConcurrency(priceOps, async (op) => {
        try {
            const data = await graphqlRequest(shop, token, VARIANTS_PRICE_MUTATION, { productId: op.productId, variants: op.variants });
            const ue = data?.productVariantsBulkUpdate?.userErrors || [];
            if (ue.length) {
                counts.failed += op.variants.length;
                errors.push({ parentCode: op.parentCode, error: `price: ${ue.map((e) => e.message).join('; ')}` });
            } else {
                counts.pricesPushed += op.variants.length;
                for (const h of op.hashes) hashUpdates.push({ sku: h.sku, priceHash: h.priceHash });
            }
        } catch (e) {
            counts.failed += op.variants.length;
            errors.push({ parentCode: op.parentCode, error: `price: ${e.message}` });
        }
    });

    await queue.mapWithConcurrency(contentOps, async (op) => {
        try {
            const data = await graphqlRequest(shop, token, PRODUCT_UPDATE_MUTATION, { product: op.product });
            const ue = data?.productUpdate?.userErrors || [];
            if (ue.length) {
                counts.failed += 1;
                errors.push({ parentCode: op.parentCode, error: `content: ${ue.map((e) => e.message).join('; ')}` });
            } else {
                counts.contentPushed += 1;
                for (const sku of op.skus) hashUpdates.push({ sku, contentHash: op.contentHash });
            }
        } catch (e) {
            counts.failed += 1;
            errors.push({ parentCode: op.parentCode, error: `content: ${e.message}` });
        }
    });

    // Merge price + content hash updates per SKU, then persist in one pass.
    if (hashUpdates.length) {
        const bySku = new Map();
        for (const h of hashUpdates) {
            const cur = bySku.get(h.sku) || { sku: h.sku };
            if (h.priceHash !== undefined) cur.priceHash = h.priceHash;
            if (h.contentHash !== undefined) cur.contentHash = h.contentHash;
            bySku.set(h.sku, cur);
        }
        await productMap.bulkSetHashes(connection._id, [...bySku.values()]);
    }
}

/**
 * Executes a stock-only sync for a connection. Caller passes the pre-created run (job) so
 * the HTTP layer can return its id immediately; this function fills in the result.
 *
 * @param {Object} connection - raw connection doc
 * @param {Object} job - the `running` job document from {@link syncJobs.startRun}
 * @param {string} token - a valid (refreshed) Admin API access token
 */
async function executeRun(connection, job, token) {
    const counts = { ...syncJobs.EMPTY_COUNTS };
    const unmatched = [];
    const errors = [];

    try {
        const locationId = connection.shopifyLocationId;
        if (!locationId) {
            throw Object.assign(new Error('No Shopify location selected for this connection'), { code: 'NO_LOCATION' });
        }
        const exportConfigId = connection.config?.exportConfigId;
        if (!exportConfigId) {
            throw Object.assign(new Error('No "Products to sync" export configuration selected'), { code: 'NO_EXPORT_CONFIG' });
        }
        const exportConfig = await getExportConfigById(exportConfigId);
        if (!exportConfig) {
            throw Object.assign(new Error('The selected export configuration no longer exists'), { code: 'NO_EXPORT_CONFIG' });
        }

        const { products: scopedProducts, items } = await buildScope(exportConfig);
        counts.inScope = items.length;
        if (!items.length) {
            await syncJobs.finishRun(job._id, { status: 'done', counts, unmatched, errors });
            await connectionService.updateLastSync(connection._id, { lastSyncStatus: 'done' });
            return;
        }

        // Authoritative map: only look up SKUs we haven't mapped before (design §7).
        const existingMap = await productMap.getMapBySku(connection._id);
        const unmapped = items.filter((it) => !existingMap.has(it.sku));

        const newMatches = [];
        if (unmapped.length) {
            const matchResult = await matchVariants(
                connection.shopDomain,
                token,
                unmapped.map((it) => ({ sku: it.sku, barcode: it.barcode }))
            );
            const itemBySku = new Map(unmapped.map((it) => [it.sku, it]));
            for (const [sku, res] of matchResult) {
                const it = itemBySku.get(sku);
                const inventoryItemId = res.node?.inventoryItem?.id;
                if (res.node && inventoryItemId) {
                    newMatches.push({
                        parentCode: it.parentCode,
                        variantCode: it.variantCode,
                        sku,
                        barcode: it.barcode,
                        shopifyProductId: res.node.product?.id,
                        shopifyVariantId: res.node.id,
                        shopifyInventoryItemId: inventoryItemId
                    });
                } else {
                    unmatched.push({
                        sku,
                        parentCode: it.parentCode,
                        // A variant with no inventory item isn't inventory-tracked in Shopify —
                        // there's nothing to set quantity on until the merchant enables tracking.
                        reason: res.node
                            ? 'Variant is not inventory-tracked in Shopify'
                            : res.reason || 'No SKU / barcode match in store',
                        tone: res.node ? 'amber' : 'red'
                    });
                }
            }
            if (newMatches.length) {
                await productMap.bulkUpsertMatches(connection._id, connection.shopDomain, newMatches);
            }
        }

        // Resolve the inventory item id for every matchable item (stored map ∪ fresh matches).
        const inventoryItemBySku = new Map();
        for (const [sku, row] of existingMap) inventoryItemBySku.set(sku, row.shopifyInventoryItemId);
        for (const m of newMatches) inventoryItemBySku.set(m.sku, m.shopifyInventoryItemId);

        const pushable = items
            .filter((it) => inventoryItemBySku.get(it.sku))
            .map((it) => ({ ...it, shopifyInventoryItemId: inventoryItemBySku.get(it.sku) }));
        counts.matched = pushable.length;
        counts.unmatched = unmatched.length;

        // ── Stock push (Phase A) — gated on the syncStock toggle (default on). ───────────
        if (connection.config?.syncStock !== false) {
            const batches = chunk(pushable, QUANTITIES_PER_CALL);
            const batchOutcomes = await queue.mapWithConcurrency(
                batches,
                (batch) => pushBatch(connection.shopDomain, token, locationId, job._id, batch)
            );

            const stateUpdates = [];
            for (let b = 0; b < batches.length; b++) {
                const outcomes = batchOutcomes[b];
                for (const it of batches[b]) {
                    const outcome = outcomes.get(it.sku) || { ok: false, error: 'No result' };
                    if (outcome.ok) {
                        counts.pushed++;
                        stateUpdates.push({ sku: it.sku, state: 'synced', hash: sha1(it.quantity), error: null });
                    } else {
                        counts.failed++;
                        errors.push({ sku: it.sku, parentCode: it.parentCode, error: outcome.error });
                        stateUpdates.push({ sku: it.sku, state: 'error', error: outcome.error });
                    }
                }
            }
            if (stateUpdates.length) await productMap.bulkSetState(connection._id, stateUpdates);
        }

        // ── Content + price push (Phase C) — only when the partner has opted up to the
        //    `portal_authoritative` ownership mode (design §9). Operates on matched products. ──
        if (connection.config?.ownership === 'portal_authoritative') {
            const matchInfoBySku = new Map();
            for (const [sku, row] of existingMap) {
                matchInfoBySku.set(sku, { shopifyVariantId: row.shopifyVariantId, shopifyProductId: row.shopifyProductId });
            }
            for (const m of newMatches) {
                matchInfoBySku.set(m.sku, { shopifyVariantId: m.shopifyVariantId, shopifyProductId: m.shopifyProductId });
            }
            await pushPortalAuthoritative({
                connection, token, scopedProducts, matchInfoBySku, existingMap, exportConfig, counts, errors
            });
        }

        const status = counts.failed || counts.unmatched ? 'partial' : 'done';
        await syncJobs.finishRun(job._id, { status, counts, unmatched, errors });
        await connectionService.updateLastSync(connection._id, {
            lastSyncStatus: counts.failed ? 'failed' : 'done'
        });
    } catch (err) {
        console.error(`[shopify] sync run ${job._id} failed:`, err.code || '', err.message);
        await syncJobs.finishRun(job._id, {
            status: 'failed',
            counts,
            unmatched,
            errors,
            error: err.message
        });
        await connectionService.updateLastSync(connection._id, { lastSyncStatus: 'failed' });
    }
}

/**
 * Public entry point for a manual / triggered stock sync. Validates the connection is
 * active, opens a run, and kicks off {@link executeRun} **in the background** (serialized
 * per shop). Returns the run document so the API can respond 202 with an id to poll.
 *
 * Rejects fast (typed errors) when the connection isn't syncable or a run is already in
 * flight for the shop, so a double-click can't launch two overlapping runs.
 *
 * @param {ObjectId|string} connectionId
 * @param {{ trigger?: string }} [opts]
 * @returns {Promise<Object>} the started job
 */
async function startStockSync(connectionId, { trigger = 'manual' } = {}) {
    const connection = await connectionService.getConnectionWithToken(connectionId);
    if (!connection) {
        throw Object.assign(new Error('Connection not found'), { code: 'NOT_FOUND' });
    }
    if (connection.status !== 'active' || !connection.accessTokenEnc) {
        throw Object.assign(new Error('Connection is not active'), { code: 'NOT_ACTIVE' });
    }
    if (queue.isBusy(connection.shopDomain)) {
        throw Object.assign(new Error('A sync is already running for this store'), { code: 'SYNC_BUSY' });
    }

    // Resolve a valid (refreshed) token BEFORE opening a run, so a connection needing
    // re-auth fails fast with a clear 401 instead of a background "failed" run.
    const token = await getValidAccessToken(connection._id);

    // Clean up any zombie 'running' rows from a prior crash before opening a fresh run.
    await syncJobs.failStaleRuns(connection._id);
    const job = await syncJobs.startRun(connection._id, connection.shopDomain, { type: 'inventory', trigger });

    // Fire-and-forget under the per-shop lock; the controller already has the job id.
    queue.runExclusive(connection.shopDomain, () => executeRun(connection, job, token)).catch((err) => {
        console.error(`[shopify] unexpected sync error for ${connection.shopDomain}:`, err.message);
    });

    return job;
}

module.exports = {
    startStockSync,
    // exported for tests / future triggers (PNV delta, n8n reconcile)
    executeRun,
    buildScope,
    resolvePushPrice
};
