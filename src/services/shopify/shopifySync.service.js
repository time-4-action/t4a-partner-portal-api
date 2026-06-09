const crypto = require('crypto');
const { getDb } = require('../db/mongo.service');
const { getValidAccessToken } = require('./shopifyToken.service');
const connectionService = require('./shopifyConnection.service');
const { getExportConfigById, applyFilters, getPriceFromPriority, resolveTagsArray } = require('../customExport.service');
const { matchVariants } = require('./shopifyMatch.service');
const productMap = require('./shopifyProductMap.service');
const syncJobs = require('./shopifySyncJobs.service');
const queue = require('./shopifyQueue.service');
const { graphqlRequest, publishToPublications, unpublishFromPublications, listPublications } = require('./shopifyGraphql.service');

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

// Activates an inventory item at a location AND sets its available quantity. Needed because
// `inventorySetQuantities` silently no-ops for an item that isn't yet stocked at the target
// location (returns no error but creates no inventory level) — which broke syncing to a newly
// chosen location. `@idempotent` is required on 2026-04 inventory mutations.
const INVENTORY_ACTIVATE_MUTATION = `mutation InventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int, $idempotencyKey: String!) {
  inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $idempotencyKey) {
    inventoryLevel { id }
    userErrors { field message }
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

// Phase B — product create (creates listings for unmatched products when syncNewProducts is on).
const PRODUCT_CREATE_MUTATION = `mutation ProductCreate($product: ProductCreateInput!) {
  productCreate(product: $product) {
    product { id handle }
    userErrors { field message }
  }
}`;

const VARIANTS_BULK_CREATE_MUTATION = `mutation VariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
  productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
    productVariants { id sku inventoryItem { id } }
    userErrors { field message }
  }
}`;

// Phase D — image sync. productCreateMedia is deprecated on 2026-04; the supported path is
// productUpdate with a `media` arg (adds media, processed asynchronously by Shopify).
const PRODUCT_MEDIA_QUERY = `query ProductMedia($id: ID!) { product(id: $id) { media(first: 1) { nodes { id } } } }`;

const PRODUCT_UPDATE_MEDIA_MUTATION = `mutation ProductUpdateMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
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
 * True when a push error means the Shopify target no longer exists (the merchant deleted the
 * product/variant) — as opposed to a transient/validation failure. Such SKUs are stale in our
 * map: we drop them so the next sync re-matches, rather than retrying a dead id forever.
 */
const isStaleError = (msg) => /could not be found|does not exist|doesn'?t exist|not found|no longer exists|was deleted|been deleted|couldn'?t be stocked|could not be stocked/i.test(msg || '');

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
async function pushPortalAuthoritative({ connection, token, scopedProducts, matchInfoBySku, existingMap, exportConfig, counts, errors, staleSkus, unmatched }) {
    const cfg = connection.config || {};
    const wantPrices = !!cfg.syncPrices;
    const wantContent = !!cfg.syncDescriptions;
    if (!wantPrices && !wantContent) return;

    const vatMode = cfg.priceVatMode || 'inclusive';
    const futureGuard = cfg.futureDatedGuard !== false;
    const pricelistPriority = cfg.pricelistPriority || [];
    const nowMs = Date.now();
    const shop = connection.shopDomain;

    // Records a SKU whose Shopify target was deleted: queue its map row for removal and report
    // it once (dedup against rows the stock push already flagged).
    const markStale = (parentCode, skus) => {
        for (const sku of skus) {
            if (staleSkus.has(sku)) continue;
            staleSkus.add(sku);
            unmatched.push({ sku, parentCode, reason: 'Removed in Shopify — will re-match next sync', tone: 'amber' });
        }
    };

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
            const msg = ue.map((e) => e.message).join('; ');
            if (ue.length && isStaleError(msg)) {
                markStale(op.parentCode, op.hashes.map((h) => h.sku));
            } else if (ue.length) {
                counts.failed += op.variants.length;
                errors.push({ parentCode: op.parentCode, error: `price: ${msg}` });
            } else {
                counts.pricesPushed += op.variants.length;
                for (const h of op.hashes) hashUpdates.push({ sku: h.sku, priceHash: h.priceHash });
            }
        } catch (e) {
            if (isStaleError(e.message)) markStale(op.parentCode, op.hashes.map((h) => h.sku));
            else { counts.failed += op.variants.length; errors.push({ parentCode: op.parentCode, error: `price: ${e.message}` }); }
        }
    });

    await queue.mapWithConcurrency(contentOps, async (op) => {
        try {
            const data = await graphqlRequest(shop, token, PRODUCT_UPDATE_MUTATION, { product: op.product });
            const ue = data?.productUpdate?.userErrors || [];
            const msg = ue.map((e) => e.message).join('; ');
            if (ue.length && isStaleError(msg)) {
                markStale(op.parentCode, op.skus);
            } else if (ue.length) {
                counts.failed += 1;
                errors.push({ parentCode: op.parentCode, error: `content: ${msg}` });
            } else {
                counts.contentPushed += 1;
                for (const sku of op.skus) hashUpdates.push({ sku, contentHash: op.contentHash });
            }
        } catch (e) {
            if (isStaleError(e.message)) markStale(op.parentCode, op.skus);
            else { counts.failed += 1; errors.push({ parentCode: op.parentCode, error: `content: ${e.message}` }); }
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
 * Image sync (Phase D) — pushes the parent gallery for matched products. Runs in BOTH
 * `portal_authoritative` and `create_then_handoff` ownership (design §9): images are part of
 * the product the portal stands up. The media-less guard (only add to products with no media)
 * means it never duplicates media or touches a partner's own images, which is exactly the
 * "fill in what we created, leave the rest alone" behaviour create-then-handoff wants.
 *
 * Delta-gated by a per-product `imageHash`. Mutates `counts`/`errors`, marks stale targets.
 */
async function pushImages({ connection, token, scopedProducts, matchInfoBySku, existingMap, counts, errors, staleSkus, unmatched }) {
    const shop = connection.shopDomain;
    const markStale = (parentCode, skus) => {
        for (const sku of skus) {
            if (staleSkus.has(sku)) continue;
            staleSkus.add(sku);
            unmatched.push({ sku, parentCode, reason: 'Removed in Shopify — will re-match next sync', tone: 'amber' });
        }
    };

    const imageOps = [];
    for (const product of scopedProducts) {
        const variants = product.child_products || [];
        const variantList = variants.length ? variants : [product];
        const matched = variantList
            .map((v) => ({ sku: (variants.length ? v.code : product.code) || '' }))
            .filter((x) => x.sku && matchInfoBySku.get(x.sku)?.shopifyProductId);
        if (!matched.length) continue;
        const productId = matchInfoBySku.get(matched[0].sku).shopifyProductId;
        // Parent gallery + every variant's own image(s) — variant images were previously dropped.
        const variantImages = (product.child_products || []).flatMap((v) => v.images || []);
        const images = [...new Set([...(product.images || []), ...variantImages])].filter(Boolean);
        if (!images.length) continue;
        const imageHash = sha1(images.join('|'));
        if (existingMap.get(matched[0].sku)?.imageHash === imageHash) continue; // already handled
        imageOps.push({ parentCode: product.code, productId, images, alt: product.product_name || '', skus: matched.map((m) => m.sku), imageHash });
    }
    if (!imageOps.length) return;

    const hashUpdates = [];
    await queue.mapWithConcurrency(imageOps, async (op) => {
        try {
            const cur = await graphqlRequest(shop, token, PRODUCT_MEDIA_QUERY, { id: op.productId });
            const hasMedia = (cur?.product?.media?.nodes || []).length > 0;
            if (!hasMedia) {
                const media = op.images.map((url) => ({ originalSource: url, alt: op.alt, mediaContentType: 'IMAGE' }));
                const data = await graphqlRequest(shop, token, PRODUCT_UPDATE_MEDIA_MUTATION, { product: { id: op.productId }, media });
                const ue = data?.productUpdate?.userErrors || [];
                const msg = ue.map((e) => e.message).join('; ');
                if (ue.length && isStaleError(msg)) { markStale(op.parentCode, op.skus); return; }
                if (ue.length) { counts.failed += 1; errors.push({ parentCode: op.parentCode, error: `images: ${msg}` }); return; }
                counts.imagesPushed += op.images.length;
            }
            for (const sku of op.skus) hashUpdates.push({ sku, imageHash: op.imageHash });
        } catch (e) {
            if (isStaleError(e.message)) markStale(op.parentCode, op.skus);
            else { counts.failed += 1; errors.push({ parentCode: op.parentCode, error: `images: ${e.message}` }); }
        }
    });

    if (hashUpdates.length) await productMap.bulkSetHashes(connection._id, hashUpdates);
}

/**
 * Publication management (sales channels) — `portal_authoritative` only. The portal owns the
 * product, so its published channels are a managed field: every matched product is kept in
 * sync with the connection's `publicationIds` (published to the chosen channels, unpublished
 * from the rest). Delta-gated by a per-product `publishHash`, so it only fires when the
 * selection actually changed. No-op when no channels are selected (we don't unpublish
 * everything — that would hide the catalogue).
 */
async function pushPublications({ connection, token, scopedProducts, matchInfoBySku, existingMap, counts, errors }) {
    const desired = [...(connection.config?.publicationIds || [])].sort();
    if (!desired.length) return;

    let allPubIds = [];
    try {
        allPubIds = (await listPublications(connection.shopDomain, token)).map((p) => p.id);
    } catch (err) {
        console.error('[shopify] listPublications (publish step) failed:', err.message);
        return; // can't compute the complement → skip rather than guess
    }
    const complement = allPubIds.filter((id) => !desired.includes(id));
    const publishHash = sha1(desired.join(','));
    const shop = connection.shopDomain;

    const ops = [];
    for (const product of scopedProducts) {
        const variants = product.child_products || [];
        const variantList = variants.length ? variants : [product];
        const firstSku = variantList.map((v) => (variants.length ? v.code : product.code) || '').find((sku) => matchInfoBySku.get(sku)?.shopifyProductId);
        if (!firstSku) continue;
        if (existingMap.get(firstSku)?.publishHash === publishHash) continue; // unchanged
        ops.push({ parentCode: product.code, productId: matchInfoBySku.get(firstSku).shopifyProductId, skus: variantList.map((v) => (variants.length ? v.code : product.code) || '').filter((s) => matchInfoBySku.get(s)) });
    }
    if (!ops.length) return;

    const hashUpdates = [];
    await queue.mapWithConcurrency(ops, async (op) => {
        try {
            const pe = await publishToPublications(shop, token, op.productId, desired);
            const ue = complement.length ? await unpublishFromPublications(shop, token, op.productId, complement) : [];
            const msg = [...pe, ...ue].map((e) => e.message).join('; ');
            if (msg && isStaleError(msg)) return; // product gone — stale handler elsewhere cleans it
            if (msg) { counts.failed += 1; errors.push({ parentCode: op.parentCode, error: `publish: ${msg}` }); return; }
            counts.publishedProducts += 1;
            for (const sku of op.skus) hashUpdates.push({ sku, publishHash });
        } catch (e) {
            errors.push({ parentCode: op.parentCode, error: `publish: ${e.message}` });
        }
    });
    if (hashUpdates.length) await productMap.bulkSetHashes(connection._id, hashUpdates);
}

/**
 * Activates one inventory item at the connection's location and sets its available quantity.
 * Used for items not yet stocked at that location (first sync, or after a location change).
 * Never throws — returns `{ ok, error }` so the caller records state like the batch path.
 */
async function activateInventory(shop, token, item, locationId) {
    try {
        const data = await graphqlRequest(shop, token, INVENTORY_ACTIVATE_MUTATION, {
            inventoryItemId: item.shopifyInventoryItemId,
            locationId,
            available: item.quantity,
            idempotencyKey: crypto.randomUUID()
        });
        const ue = data?.inventoryActivate?.userErrors || [];
        return ue.length ? { ok: false, error: ue.map((e) => e.message).join('; ') } : { ok: true, error: null };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** Option1 value for a variant: prefer `size`, fall back to the (unique) SKU for sizeless ones. */
const deriveOptionValue = (v) => {
    const size = v.size != null ? String(v.size).trim() : '';
    return size || v.code || '';
};

/**
 * Builds a `ProductVariantsBulkInput` for a to-be-created variant: SKU + barcode + resolved
 * price + the Option1 value, and the starting inventory at the connection's location
 * (`inventoryQuantities` both activates the item at that location and sets the quantity, so
 * the freshly-created variant doesn't need a separate inventory push).
 */
function buildCreateVariantInput(plan, v, locationId, pricelistPriority, vatMode, futureGuard, nowMs) {
    const sku = plan.skuOf(v);
    const price = resolvePushPrice(v, pricelistPriority, vatMode, futureGuard, nowMs) || '0.00';
    const optionName = plan.isNoVariant ? 'Title' : 'Size';
    const optionValue = plan.isNoVariant ? 'Default Title' : deriveOptionValue(v);
    return {
        optionValues: [{ name: optionValue, optionName }],
        price,
        barcode: v.ean_code || null,
        inventoryItem: { sku, tracked: true },
        inventoryQuantities: [{ locationId, availableQuantity: v.stock_amount || 0 }]
    };
}

/** Maps the variants returned by a bulk-create back to `shopify_product_map` rows (by SKU). */
function createdRowsFromNodes(plan, productId, nodes) {
    const bySku = new Map((nodes || []).map((n) => [n.sku, n]));
    return plan.toCreate
        .map((v) => {
            const sku = plan.skuOf(v);
            const node = bySku.get(sku);
            if (!node) return null;
            return {
                parentCode: plan.product.code,
                variantCode: plan.isNoVariant ? null : (v.code || null),
                sku,
                barcode: v.ean_code || null,
                shopifyProductId: productId,
                shopifyVariantId: node.id,
                shopifyInventoryItemId: node.inventoryItem?.id || null
            };
        })
        .filter(Boolean);
}

/**
 * Phase B — creates listings for unmatched products (those genuinely not in the store) when
 * `syncNewProducts` is on and ownership isn't stock-only. Two paths:
 *   - parent has NO existing Shopify product → `productCreate` (+ options) then
 *     `productVariantsBulkCreate` with REMOVE_STANDALONE_VARIANT.
 *   - parent already exists (some variants matched) → `productVariantsBulkCreate` adds only the
 *     missing variants to that product (no duplicate product).
 * Title/description/tags/price/barcode/SKU and starting inventory are all set on creation.
 *
 * Returns the new `shopify_product_map` rows (caller upserts them). Created SKUs are removed
 * from the `unmatched` report. Mutates `counts` and appends to `errors`.
 */
async function pushNewProducts({ connection, token, scopedProducts, unmatched, matchInfoBySku, exportConfig, locationId, counts, errors }) {
    const cfg = connection.config || {};
    const shop = connection.shopDomain;
    const vatMode = cfg.priceVatMode || 'inclusive';
    const futureGuard = cfg.futureDatedGuard !== false;
    const pricelistPriority = cfg.pricelistPriority || [];
    const publicationIds = cfg.publicationIds || []; // sales channels to publish new products to
    const nowMs = Date.now();

    // Only create SKUs that truly aren't in the store — never duplicates / ambiguous / untracked.
    const creatable = new Set(unmatched.filter((u) => u.reason === 'No SKU / barcode match in store').map((u) => u.sku));
    if (!creatable.size) return [];

    const plans = [];
    for (const product of scopedProducts) {
        const variants = product.child_products || [];
        const isNoVariant = variants.length === 0;
        const variantList = isNoVariant ? [product] : variants;
        const skuOf = (v) => (isNoVariant ? product.code : v.code) || '';
        const toCreate = variantList.filter((v) => creatable.has(skuOf(v)));
        if (!toCreate.length) continue;
        // If any sibling variant is already mapped, the Shopify product exists — add to it.
        let existingProductId = null;
        for (const v of variantList) {
            const info = matchInfoBySku.get(skuOf(v));
            if (info?.shopifyProductId) { existingProductId = info.shopifyProductId; break; }
        }
        plans.push({ product, isNoVariant, variantList, toCreate, existingProductId, skuOf });
    }
    if (!plans.length) return [];

    const created = [];
    const createdSkus = new Set();

    await queue.mapWithConcurrency(plans, async (plan) => {
        try {
            const variantInputs = plan.toCreate.map((v) =>
                buildCreateVariantInput(plan, v, locationId, pricelistPriority, vatMode, futureGuard, nowMs));

            let productId = plan.existingProductId;
            let strategy = 'DEFAULT';

            if (!productId) {
                const productInput = {
                    title: plan.product.product_name || plan.product.code || 'Untitled',
                    descriptionHtml: plan.product.detailed_description || plan.product.short_description || '',
                    vendor: 'Patrik International',
                    productType: plan.product.categories?.[0] || '',
                    status: 'ACTIVE',
                    tags: resolveTagsArray(plan.product, exportConfig) || []
                };
                if (!plan.isNoVariant) {
                    const values = [...new Set(plan.toCreate.map(deriveOptionValue).filter(Boolean))].map((name) => ({ name }));
                    productInput.productOptions = [{ name: 'Size', values }];
                }
                const cData = await graphqlRequest(shop, token, PRODUCT_CREATE_MUTATION, { product: productInput });
                const cue = cData?.productCreate?.userErrors || [];
                if (cue.length) throw new Error(cue.map((e) => e.message).join('; '));
                productId = cData.productCreate.product.id;
                strategy = 'REMOVE_STANDALONE_VARIANT';
            }

            const vData = await graphqlRequest(shop, token, VARIANTS_BULK_CREATE_MUTATION, { productId, variants: variantInputs, strategy });
            const vue = vData?.productVariantsBulkCreate?.userErrors || [];
            if (vue.length) throw new Error(vue.map((e) => e.message).join('; '));

            const rows = createdRowsFromNodes(plan, productId, vData.productVariantsBulkCreate.productVariants);
            for (const r of rows) { created.push(r); createdSkus.add(r.sku); }
            if (rows.length) {
                counts.createdVariants += rows.length;
                if (!plan.existingProductId) counts.createdProducts += 1;
            }

            // Publish the freshly-created product to the chosen sales channels (Online Store,
            // POS, …) so it's actually visible. Only for products we created here.
            if (!plan.existingProductId && publicationIds.length) {
                const pue = await publishToPublications(shop, token, productId, publicationIds);
                if (pue.length) errors.push({ parentCode: plan.product.code, error: `publish: ${pue.map((e) => e.message).join('; ')}` });
            }
        } catch (e) {
            errors.push({ parentCode: plan.product.code, error: `create: ${e.message}` });
        }
    });

    // Created SKUs are no longer "needs attention".
    if (createdSkus.size) {
        for (let i = unmatched.length - 1; i >= 0; i--) {
            if (createdSkus.has(unmatched[i].sku)) unmatched.splice(i, 1);
        }
    }
    return created;
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
    // SKUs whose Shopify target was deleted — their map rows are dropped at the end of the run
    // so the next sync re-matches them instead of pushing to a dead id.
    const staleSkus = new Set();

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

        // sku → Shopify ids for matched variants (stored ∪ freshly matched). Shared by Phase B
        // (detect a parent's existing product) and Phase C (price/content targets).
        const matchInfoBySku = new Map();
        for (const [sku, row] of existingMap) {
            matchInfoBySku.set(sku, { shopifyVariantId: row.shopifyVariantId, shopifyProductId: row.shopifyProductId });
        }
        for (const m of newMatches) {
            matchInfoBySku.set(m.sku, { shopifyVariantId: m.shopifyVariantId, shopifyProductId: m.shopifyProductId });
        }

        // Parent codes created in THIS run — in create_then_handoff, images are pushed only for
        // these (creation-time), never for products that already existed.
        const createdParentCodes = new Set();

        // ── Product create (Phase B) — turn unmatched products into listings. Runs before the
        //    stock push; created variants get their inventory set during creation, so they're
        //    not in this run's stock batch (future runs maintain them as matched).
        //    create_then_handoff ALWAYS creates (it's the mode's whole purpose), so an unmatched
        //    product becomes a new listing rather than a "needs attention" item — regardless of
        //    the New-products toggle. Other modes honour the toggle. ────────────────────────────
        const wantCreate = connection.config?.ownership === 'create_then_handoff'
            || (connection.config?.syncNewProducts && connection.config?.ownership !== 'stock_only');
        if (wantCreate) {
            const createdRows = await pushNewProducts({
                connection, token, scopedProducts, unmatched, matchInfoBySku, exportConfig, locationId, counts, errors
            });
            if (createdRows.length) {
                await productMap.bulkUpsertMatches(connection._id, connection.shopDomain, createdRows);
                // Inventory (at this location), price + content were all set at creation → mark
                // synced and record the stock location so future runs use the fast batched set.
                await productMap.bulkSetState(connection._id, createdRows.map((r) => ({ sku: r.sku, state: 'synced', error: null, stockLocationId: locationId })));
                // Make created products visible to the image step so they get their gallery this
                // run too (create doesn't push media).
                for (const r of createdRows) {
                    matchInfoBySku.set(r.sku, { shopifyVariantId: r.shopifyVariantId, shopifyProductId: r.shopifyProductId });
                    createdParentCodes.add(r.parentCode);
                }
            }
        }

        // ── Stock push (Phase A) — gated on the syncStock toggle (default on). ───────────
        if (connection.config?.syncStock !== false) {
            const stateUpdates = [];
            const recordOutcome = (it, outcome, activated) => {
                if (outcome.ok) {
                    counts.pushed++;
                    const u = { sku: it.sku, state: 'synced', hash: sha1(it.quantity), error: null };
                    // Remember we stocked this item at this location → fast batched set next time.
                    if (activated) u.stockLocationId = locationId;
                    stateUpdates.push(u);
                } else if (isStaleError(outcome.error)) {
                    // Target deleted in Shopify — drop the mapping (re-match next sync).
                    staleSkus.add(it.sku);
                    unmatched.push({ sku: it.sku, parentCode: it.parentCode, reason: 'Removed in Shopify — will re-match next sync', tone: 'amber' });
                } else {
                    counts.failed++;
                    errors.push({ sku: it.sku, parentCode: it.parentCode, error: outcome.error });
                    stateUpdates.push({ sku: it.sku, state: 'error', error: outcome.error });
                }
            };

            // An item already stocked at THIS location can use the fast batched set; one that
            // isn't (new item, or the partner changed the location) must be activated first —
            // inventorySetQuantities silently no-ops on an un-stocked location.
            const stockedHere = [];
            const needActivate = [];
            for (const it of pushable) {
                if (existingMap.get(it.sku)?.stockLocationId === locationId) stockedHere.push(it);
                else needActivate.push(it);
            }

            const batches = chunk(stockedHere, QUANTITIES_PER_CALL);
            const batchOutcomes = await queue.mapWithConcurrency(
                batches,
                (batch) => pushBatch(connection.shopDomain, token, locationId, job._id, batch)
            );
            for (let b = 0; b < batches.length; b++) {
                for (const it of batches[b]) {
                    recordOutcome(it, batchOutcomes[b].get(it.sku) || { ok: false, error: 'No result' }, false);
                }
            }

            const actOutcomes = await queue.mapWithConcurrency(
                needActivate,
                (it) => activateInventory(connection.shopDomain, token, it, locationId)
            );
            needActivate.forEach((it, i) => recordOutcome(it, actOutcomes[i], true));

            if (stateUpdates.length) await productMap.bulkSetState(connection._id, stateUpdates);
        }

        // ── Content + price push (Phase C) — only when the partner has opted up to the
        //    `portal_authoritative` ownership mode (design §9). Operates on matched products. ──
        // Don't re-hit SKUs the stock push already found deleted.
        for (const sku of staleSkus) matchInfoBySku.delete(sku);

        // Price + description updates: portal_authoritative only (it overwrites managed fields
        // every sync). create_then_handoff sets those once at creation and then leaves them.
        if (connection.config?.ownership === 'portal_authoritative') {
            await pushPortalAuthoritative({
                connection, token, scopedProducts, matchInfoBySku, existingMap, exportConfig, counts, errors, staleSkus, unmatched
            });
            // Sales channels are a managed field here too: keep existing products in sync with
            // the selected channels (publish/unpublish), not just newly-created ones.
            await pushPublications({
                connection, token, scopedProducts, matchInfoBySku, existingMap, counts, errors
            });
        }

        // Images: in BOTH portal_authoritative and create_then_handoff (images are part of the
        // product the portal stands up), but with different scope:
        //   - create_then_handoff → ONLY products created this run (images belong to the create;
        //     existing products are never re-touched, so a later catalogue image change stays
        //     intact in Shopify — the "handoff").
        //   - portal_authoritative → any matched media-less product (the portal fills images).
        if (connection.config?.syncImages && connection.config?.ownership !== 'stock_only') {
            const imageProducts = connection.config.ownership === 'create_then_handoff'
                ? scopedProducts.filter((p) => createdParentCodes.has(p.code))
                : scopedProducts;
            if (imageProducts.length) {
                await pushImages({
                    connection, token, scopedProducts: imageProducts, matchInfoBySku, existingMap, counts, errors, staleSkus, unmatched
                });
            }
        }

        // Drop any stale mappings discovered this run; they re-match on the next sync.
        if (staleSkus.size) await productMap.deleteBySkus(connection._id, [...staleSkus]);

        counts.unmatched = unmatched.length;
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

/**
 * Fans a sync out across every sync-ready connection — the automatic triggers (design §8.1):
 * the PNV-end delta push and the n8n nightly reconcile both call this. Each connection's run
 * is kicked off in the background (serialized per shop), so this returns quickly after setup.
 * Connections that aren't ready / are busy / need re-auth are skipped, never throwing.
 *
 * @param {{ trigger?: string }} [opts]
 * @returns {Promise<Array<{ shop: string, jobId?: string, skipped?: string }>>}
 */
async function syncAllConnections({ trigger = 'reconcile' } = {}) {
    const connections = await connectionService.listActiveSyncable();
    const results = [];
    for (const conn of connections) {
        try {
            const job = await startStockSync(conn._id, { trigger });
            results.push({ shop: conn.shopDomain, jobId: job._id.toString() });
        } catch (err) {
            // SYNC_BUSY / REAUTH_REQUIRED / NO_EXPORT_CONFIG etc. — skip this store, keep going.
            results.push({ shop: conn.shopDomain, skipped: err.code || err.message });
        }
    }
    return results;
}

module.exports = {
    startStockSync,
    syncAllConnections,
    // exported for tests / future triggers (PNV delta, n8n reconcile)
    executeRun,
    buildScope,
    resolvePushPrice,
    pushNewProducts,
    pushImages
};
