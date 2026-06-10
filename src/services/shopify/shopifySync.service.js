const crypto = require('crypto');
const { getDb } = require('../db/mongo.service');
const { getValidAccessToken } = require('./shopifyToken.service');
const connectionService = require('./shopifyConnection.service');
const { getExportConfigById, applyFilters, getPriceFromPriority, resolveTagsArray } = require('../customExport.service');
const { matchVariants } = require('./shopifyMatch.service');
const productMap = require('./shopifyProductMap.service');
const syncJobs = require('./shopifySyncJobs.service');
const queue = require('./shopifyQueue.service');
const { graphqlRequest, publishToPublications, unpublishFromPublications, listPublications, findExistingIds } = require('./shopifyGraphql.service');
const externalProducts = require('../external/externalProducts.service');

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

// Declarative create with media linked to variants (productCreate + bulkCreate can't attach a
// variant image at create — media is async/non-ready). productSet sets the whole product —
// gallery, variants, per-variant image, price, barcode, sku, inventory — in one synchronous call.
const PRODUCT_SET_MUTATION = `mutation ProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
  productSet(synchronous: $synchronous, input: $input) {
    product { id variants(first: 100) { nodes { id sku inventoryItem { id } } } }
    userErrors { field message }
  }
}`;

// Phase D — image sync. productCreateMedia is deprecated on 2026-04; the supported path is
// productUpdate with a `media` arg (adds media, processed asynchronously by Shopify).
// The query also pulls media `status` (a FAILED node must not count as "present") and each
// variant's linked media — deleting a product image in Shopify silently drops its variant
// link too, so the reconcile has to restore both.
const PRODUCT_MEDIA_QUERY = `query ProductMedia($id: ID!) { product(id: $id) {
  media(first: 100) { nodes { id alt status } }
  variants(first: 100) { nodes { id sku media(first: 10) { nodes { id alt } } } }
} }`;

const PRODUCT_UPDATE_MEDIA_MUTATION = `mutation ProductUpdateMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
    product { id }
    userErrors { field message }
  }
}`;

// Variant images: links existing product media to a variant / removes a stale link. The media
// must be READY — freshly-added media is processed asynchronously, so the caller polls first.
const VARIANT_APPEND_MEDIA_MUTATION = `mutation VariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
  productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
    productVariants { id }
    userErrors { field message }
  }
}`;

const VARIANT_DETACH_MEDIA_MUTATION = `mutation VariantDetachMedia($productId: ID!, $variantMedia: [ProductVariantDetachMediaInput!]!) {
  productVariantDetachMedia(productId: $productId, variantMedia: $variantMedia) {
    productVariants { id }
    userErrors { field message }
  }
}`;

// Restores the gallery order (zero-based positions; evaluated in order). Async job Shopify-side.
const PRODUCT_REORDER_MEDIA_MUTATION = `mutation ProductReorderMedia($id: ID!, $moves: [MoveInput!]!) {
  productReorderMedia(id: $id, moves: $moves) {
    job { id }
    mediaUserErrors { field message }
  }
}`;

// Removes media stuck in FAILED (source URL not downloadable etc.) — a failed node still
// carries our alt, so left in place it would mask the image as "present" forever.
// (productDeleteMedia is deprecated in favour of fileDelete, but that needs the write_files
// scope the app doesn't request; this form still validates on 2026-04.)
const PRODUCT_DELETE_MEDIA_MUTATION = `mutation ProductDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds
    mediaUserErrors { field message }
  }
}`;

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    return { products: filtered, items: itemsFromProducts(filtered) };
}

/**
 * Flattens a list of products (internal shape) into the sellable inventory items the push
 * operates on: one row per published variant SKU (or the parent for a no-variant product),
 * SKU-less / duplicate SKUs dropped. Shared by {@link buildScope} (Patrik) and
 * {@link buildExternalScope} (Own Source feeds) so both produce the identical contract.
 */
function itemsFromProducts(products) {
    const items = [];
    const seen = new Set();
    for (const product of products) {
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
    return items;
}

/**
 * The Own Source equivalent of {@link buildScope} (design §8.3): reads the published/active
 * `external_products` for a feed and returns the IDENTICAL `{ products, items }` contract. The
 * docs are already in the internal product shape, so everything downstream (matching, price via
 * {@link resolvePushPrice}, tags via {@link resolveTagsArray}, create/content/image phases) is
 * untouched — the engine is brand-blind.
 */
async function buildExternalScope(feedId) {
    const products = await externalProducts.readPublished(feedId);
    return { products, items: itemsFromProducts(products) };
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
    // Tags are managed independently of the title/description (own toggle). `syncTags` defaults
    // ON for back-compat (tags used to ride along with content).
    const wantTags = cfg.syncTags !== false;
    if (!wantPrices && !wantContent && !wantTags) return;

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

        if (wantContent || wantTags) {
            // Only set the fields this source manages — title/description (wantContent) and/or
            // tags (wantTags) — so one can be pushed without clobbering the other.
            const productUpdate = { id: productId };
            const hashParts = {};
            if (wantContent) {
                productUpdate.title = product.product_name || '';
                productUpdate.descriptionHtml = product.detailed_description || product.short_description || '';
                hashParts.title = productUpdate.title;
                hashParts.descriptionHtml = productUpdate.descriptionHtml;
            }
            if (wantTags) {
                productUpdate.tags = resolveTagsArray(product, exportConfig) || [];
                hashParts.tags = productUpdate.tags;
            }
            const contentHash = sha1(JSON.stringify(hashParts));
            if (existingMap.get(matched[0].sku)?.contentHash !== contentHash) {
                contentOps.push({ parentCode: product.code, product: productUpdate, skus: matched.map((m) => m.sku), contentHash });
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

/** First non-FAILED media node per alt URL (the alts we stamp are the source URLs). */
const mediaIndexByAlt = (prod) => {
    const byAlt = new Map();
    for (const n of prod?.media?.nodes || []) {
        if (n.alt && n.status !== 'FAILED' && !byAlt.has(n.alt)) byAlt.set(n.alt, n);
    }
    return byAlt;
};

/**
 * Re-fetches the product until freshly-added media has finished Shopify-side processing
 * (linking and reliable reordering both need settled media). Bounded poll — anything still
 * processing after it is picked up on the next sync (authoritative re-checks every run).
 */
async function settleMedia({ shop, token, op, firstLoad, addedNow, desired }) {
    let prod = firstLoad;
    const refetch = async () => (await graphqlRequest(shop, token, PRODUCT_MEDIA_QUERY, { id: op.productId }))?.product;
    const pending = () => (prod?.media?.nodes || []).some(
        (n) => n.alt && desired.has(n.alt) && n.status !== 'READY' && n.status !== 'FAILED'
    );
    if (addedNow) { await sleep(1500); prod = await refetch(); }
    for (let i = 0; i < 5 && pending(); i++) { await sleep(2000); prod = await refetch(); }
    return prod || firstLoad;
}

/**
 * portal_authoritative only: the gallery ORDER is managed too. A re-added image lands at the
 * END of the gallery (and merchants can drag-sort), so whenever our media's order drifts from
 * the catalogue's image order it is restored — our media moves to the front in catalogue
 * order; merchant-added media keeps its relative order after it. Fires only on actual drift
 * (the reorder is an async Shopify job).
 */
async function reorderGallery({ shop, token, op, prod, counts, errors }) {
    const byAlt = mediaIndexByAlt(prod);
    const desiredIds = op.images.map((url) => byAlt.get(url)?.id).filter(Boolean);
    const currentIds = (prod?.media?.nodes || []).map((n) => n.id);
    if (desiredIds.every((id, i) => currentIds[i] === id)) return; // already in order
    const moves = desiredIds.map((id, i) => ({ id, newPosition: String(i) }));
    const data = await graphqlRequest(shop, token, PRODUCT_REORDER_MEDIA_MUTATION, { id: op.productId, moves });
    const ue = data?.productReorderMedia?.mediaUserErrors || [];
    if (ue.length) { counts.failed += 1; errors.push({ parentCode: op.parentCode, error: `image order: ${ue.map((e) => e.message).join('; ')}` }); }
}

/**
 * (Re)links each variant to its own image (`variant.images[0]`), matched by media alt. Runs
 * after the gallery reconcile because both halves of the same problem end here: a media
 * deleted in Shopify takes its variant link down with it (the re-added copy is a NEW media
 * id), and media pushed onto an already-existing matched product lands in the gallery only,
 * never linked to a variant. An append is paired with a detach of any OTHER portal-managed
 * media still linked to that variant (so the right image shows); merchant-added variant media
 * is never touched. Takes the settled product from {@link settleMedia} (media must be READY).
 */
async function linkVariantImages({ shop, token, op, prod, desired, counts, errors }) {
    const wants = (op.variantWants || []).filter((w) => desired.has(w.url));
    if (!wants.length) return;

    const byAlt = mediaIndexByAlt(prod);
    const variantsBySku = new Map((prod?.variants?.nodes || []).map((v) => [v.sku, v]));
    const appends = [];
    const detaches = [];
    for (const w of wants) {
        const variant = variantsBySku.get(w.sku);
        const media = byAlt.get(w.url);
        if (!variant || !media || media.status !== 'READY') continue; // not linkable this run
        const linked = variant.media?.nodes || [];
        if (linked.some((m) => m.id === media.id)) continue; // already correct
        const stale = linked.filter((m) => m.alt && desired.has(m.alt)).map((m) => m.id);
        if (stale.length) detaches.push({ variantId: variant.id, mediaIds: stale });
        appends.push({ variantId: variant.id, mediaIds: [media.id] });
    }

    if (detaches.length) {
        const d = await graphqlRequest(shop, token, VARIANT_DETACH_MEDIA_MUTATION, { productId: op.productId, variantMedia: detaches });
        const ue = d?.productVariantDetachMedia?.userErrors || [];
        if (ue.length) { counts.failed += 1; errors.push({ parentCode: op.parentCode, error: `variant images (detach): ${ue.map((e) => e.message).join('; ')}` }); return; }
    }
    if (appends.length) {
        const a = await graphqlRequest(shop, token, VARIANT_APPEND_MEDIA_MUTATION, { productId: op.productId, variantMedia: appends });
        const ue = a?.productVariantAppendMedia?.userErrors || [];
        if (ue.length) { counts.failed += 1; errors.push({ parentCode: op.parentCode, error: `variant images: ${ue.map((e) => e.message).join('; ')}` }); return; }
        counts.variantImagesLinked += appends.length;
    }
}

/**
 * Image sync (Phase D) — pushes the parent gallery + variant images for matched products.
 *
 * Every image WE add carries `alt = its source URL`, which is the reliable key for telling
 * which of our images are currently present (Shopify rehosts images on its CDN, so the URL is
 * otherwise unrecoverable). So:
 *   - `authoritative` (portal_authoritative): the portal OWNS the images. Each sync it compares
 *     our desired set to the media currently present (by alt) and **re-adds any that are
 *     missing** — whether one image was deleted or all of them — without duplicating the ones
 *     still there. New catalogue images are added too. Media stuck in FAILED is dropped first
 *     (a failed node still carries our alt and would mask the image as "present" forever).
 *     Each variant is then (re)linked to its own image ({@link linkVariantImages}).
 *   - non-authoritative (create_then_handoff): media-less guard — only fill products that have
 *     NO media (the ones we created), never re-touch existing/partner media. Variants are
 *     linked once, at that fill.
 *
 * Mutates `counts`/`errors`, marks stale targets.
 */
async function pushImages({ connection, token, scopedProducts, matchInfoBySku, existingMap, counts, errors, staleSkus, unmatched, authoritative }) {
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
        const firstSku = matched[0].sku;
        const productId = matchInfoBySku.get(firstSku).shopifyProductId;
        const variantImages = (product.child_products || []).flatMap((v) => v.images || []);
        const images = [...new Set([...(product.images || []), ...variantImages])].filter(Boolean);
        if (!images.length) continue;
        const imageHash = sha1(images.join('|'));
        // Non-authoritative: once handled (imageHash matches), skip — don't even re-query.
        // Authoritative: always check, to catch images deleted in Shopify since last sync.
        if (!authoritative && existingMap.get(firstSku)?.imageHash === imageHash) continue;
        // Each variant's own image (its first), for the variant-link pass.
        const variantWants = variants
            .map((v) => ({ sku: v.code || '', url: (v.images || [])[0] || null }))
            .filter((w) => w.sku && w.url && matchInfoBySku.get(w.sku)?.shopifyProductId);
        imageOps.push({ parentCode: product.code, productId, images, skus: matched.map((m) => m.sku), imageHash, variantWants });
    }
    if (!imageOps.length) return;

    const hashUpdates = [];
    await queue.mapWithConcurrency(imageOps, async (op) => {
        try {
            const desired = new Set(op.images);
            const firstLoad = (await graphqlRequest(shop, token, PRODUCT_MEDIA_QUERY, { id: op.productId }))?.product;
            let nodes = firstLoad?.media?.nodes || [];

            // Drop FAILED nodes carrying one of our alts so the image can be re-attempted.
            const failedNodes = nodes.filter((n) => n.status === 'FAILED' && desired.has(n.alt));
            if (failedNodes.length) {
                await graphqlRequest(shop, token, PRODUCT_DELETE_MEDIA_MUTATION, {
                    productId: op.productId, mediaIds: failedNodes.map((n) => n.id)
                }).catch(() => {});
                nodes = nodes.filter((n) => !failedNodes.includes(n));
            }

            // Which of our images are already on the product (matched by the alt we stamped).
            const presentUrls = new Set(nodes.map((n) => n.alt).filter(Boolean));

            let toAdd;
            if (!authoritative) {
                // Fill only media-less products (created/handoff); never re-touch existing media.
                toAdd = nodes.length === 0 ? op.images : [];
            } else {
                // Re-add any of our images missing from the product (one or many).
                toAdd = op.images.filter((url) => !presentUrls.has(url));
            }

            if (toAdd.length) {
                const media = toAdd.map((url) => ({ originalSource: url, alt: url, mediaContentType: 'IMAGE' }));
                const data = await graphqlRequest(shop, token, PRODUCT_UPDATE_MEDIA_MUTATION, { product: { id: op.productId }, media });
                const ue = data?.productUpdate?.userErrors || [];
                const msg = ue.map((e) => e.message).join('; ');
                if (ue.length && isStaleError(msg)) { markStale(op.parentCode, op.skus); return; }
                if (ue.length) { counts.failed += 1; errors.push({ parentCode: op.parentCode, error: `images: ${msg}` }); return; }
                counts.imagesPushed += toAdd.length;
            }

            // Gallery order + variant-image links: authoritative reconciles every run; handoff
            // only at its one-time fill (so created/filled products still get variant images).
            if (authoritative || toAdd.length) {
                const settled = await settleMedia({ shop, token, op, firstLoad, addedNow: toAdd.length > 0, desired });
                // Order is managed in portal_authoritative — a re-added image lands at the END
                // of the gallery, so restore the catalogue order when it drifted.
                if (authoritative) await reorderGallery({ shop, token, op, prod: settled, counts, errors });
                await linkVariantImages({ shop, token, op, prod: settled, desired, counts, errors });
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

/** Sets available quantity for ONE already-stocked inventory item (single inventorySetQuantities). */
async function setInventoryOne(shop, token, item, locationId) {
    const input = {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: `${PORTAL_APP_NS}/SyncJob/activate-fallback`,
        quantities: [{ inventoryItemId: item.shopifyInventoryItemId, locationId, quantity: item.quantity, changeFromQuantity: null }]
    };
    const data = await graphqlRequest(shop, token, INVENTORY_SET_MUTATION, { input, idempotencyKey: crypto.randomUUID() });
    const ue = data?.inventorySetQuantities?.userErrors || [];
    return ue.length ? { ok: false, error: ue.map((e) => e.message).join('; ') } : { ok: true, error: null };
}

/**
 * Activates one inventory item at the connection's location and sets its available quantity.
 * Used for items not yet stocked at that location (first sync, or after a location change).
 *
 * If the item turns out to be ALREADY active at the location, `inventoryActivate` rejects with
 * "Not allowed to set available quantity when the item is already active" — in that case we
 * fall back to `inventorySetQuantities` (the right call for an active item). Never throws.
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
        if (!ue.length) return { ok: true, error: null };
        const msg = ue.map((e) => e.message).join('; ');
        if (/already active/i.test(msg)) return await setInventoryOne(shop, token, item, locationId);
        return { ok: false, error: msg };
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

/**
 * Builds the `ProductSetInput` for creating a new product with its variants AND per-variant
 * images linked (design §3.5). Each variant's own image becomes its variant image; the parent
 * gallery + all variant images form the product files. price/barcode/sku/inventory set inline.
 */
function buildProductSetInput(plan, exportConfig, locationId, pricelistPriority, vatMode, futureGuard, nowMs, wantTags = true) {
    const product = plan.product;
    const parentImages = [...new Set(product.images || [])].filter(Boolean);
    const variantImageUrls = [];

    const variants = plan.toCreate.map((v) => {
        const sku = plan.skuOf(v);
        const price = resolvePushPrice(v, pricelistPriority, vatMode, futureGuard, nowMs) || '0.00';
        const optionName = plan.isNoVariant ? 'Title' : 'Size';
        const optionValue = plan.isNoVariant ? 'Default Title' : deriveOptionValue(v);
        const vImg = (v.images && v.images[0]) || null;
        if (vImg) variantImageUrls.push(vImg);
        const vin = {
            optionValues: [{ optionName, name: optionValue }],
            price,
            barcode: v.ean_code || null,
            inventoryItem: { sku, tracked: true },
            inventoryQuantities: [{ locationId, name: 'available', quantity: v.stock_amount || 0 }]
        };
        // A variant file must ALSO appear in the product files list (Shopify requirement).
        // alt = the source URL so we can reliably tell later which media is which (Shopify
        // rehosts images on its CDN, so the URL is otherwise unrecoverable).
        if (vImg) vin.file = { originalSource: vImg, contentType: 'IMAGE', alt: vImg };
        return vin;
    });

    const allFiles = [...new Set([...parentImages, ...variantImageUrls])].filter(Boolean)
        .map((url) => ({ originalSource: url, contentType: 'IMAGE', alt: url }));

    const input = {
        title: product.product_name || product.code || 'Untitled',
        descriptionHtml: product.detailed_description || product.short_description || '',
        // Own-source products carry their own brand as `vendor`; Patrik products have none → default.
        vendor: product.vendor || 'Patrik International',
        productType: product.categories?.[0] || '',
        status: 'ACTIVE',
        tags: wantTags ? (resolveTagsArray(product, exportConfig) || []) : [],
        variants
    };
    // productSet requires productOptions whenever variants are provided (even the single
    // default variant of a no-variant product → Title / Default Title).
    input.productOptions = plan.isNoVariant
        ? [{ name: 'Title', values: [{ name: 'Default Title' }] }]
        : [{ name: 'Size', values: [...new Set(plan.toCreate.map(deriveOptionValue).filter(Boolean))].map((name) => ({ name })) }];
    if (allFiles.length) input.files = allFiles;
    return input;
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
    const wantTags = cfg.syncTags !== false; // tags on newly-created products (own toggle)
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
            let productId;
            let variantNodes;

            if (!plan.existingProductId) {
                // New product → productSet (links each variant's own image to the variant).
                const input = buildProductSetInput(plan, exportConfig, locationId, pricelistPriority, vatMode, futureGuard, nowMs, wantTags);
                const data = await graphqlRequest(shop, token, PRODUCT_SET_MUTATION, { input, synchronous: true });
                const ue = data?.productSet?.userErrors || [];
                if (ue.length) throw new Error(ue.map((e) => e.message).join('; '));
                productId = data.productSet.product.id;
                variantNodes = data.productSet.product.variants.nodes;
            } else {
                // Parent already exists → add only the missing variants (no whole-product reset).
                const variantInputs = plan.toCreate.map((v) =>
                    buildCreateVariantInput(plan, v, locationId, pricelistPriority, vatMode, futureGuard, nowMs));
                const vData = await graphqlRequest(shop, token, VARIANTS_BULK_CREATE_MUTATION, { productId: plan.existingProductId, variants: variantInputs, strategy: 'DEFAULT' });
                const vue = vData?.productVariantsBulkCreate?.userErrors || [];
                if (vue.length) throw new Error(vue.map((e) => e.message).join('; '));
                productId = plan.existingProductId;
                variantNodes = vData.productVariantsBulkCreate.productVariants;
            }

            const rows = createdRowsFromNodes(plan, productId, variantNodes);
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
 * Resolves the connection's push targets — one per scope, each with its OWN Shopify location.
 *
 * A connection can push several sources to the SAME store at DIFFERENT locations (e.g. Patrik at
 * the main warehouse, a Point-7 feed at a brand location). That's modelled as `config.scopes[]`,
 * each `{ type, exportConfigId|feedId, locationId }`. Back-compat: a legacy single `config.scope`
 * (or bare `config.exportConfigId`) becomes one scope at the connection-level `shopifyLocationId`.
 *
 * @returns {Array<{ type:string, exportConfigId?:string, feedId?:string, locationId:string|null }>}
 */
function getScopeList(connection) {
    const cfg = connection.config || {};
    if (Array.isArray(cfg.scopes) && cfg.scopes.length) {
        // Preserve the whole scope (it carries its own per-source push config), only defaulting
        // the location to the connection-level one when the scope doesn't set its own.
        return cfg.scopes.map((s) => ({ ...s, locationId: s.locationId || connection.shopifyLocationId || null }));
    }
    const single = cfg.scope
        ?? (cfg.exportConfigId ? { type: 'export_config', exportConfigId: cfg.exportConfigId } : null);
    return single ? [{ ...single, locationId: connection.shopifyLocationId || null }] : [];
}

/** Short human label for a scope, for error messages. */
function scopeLabel(sc) {
    return sc.type === 'own_source' ? `feed ${sc.feedId}` : `export ${sc.exportConfigId}`;
}

/** Per-source push settings (design: each source is configured independently). */
const SCOPE_CONFIG_KEYS = [
    'ownership', 'syncStock', 'syncNewProducts', 'syncPrices', 'syncDescriptions', 'syncImages',
    'syncTags', 'priceVatMode', 'futureDatedGuard', 'pricelistPriority', 'publicationIds'
];

/**
 * Resolves the EFFECTIVE push config for one scope. Each source configures its own ownership /
 * what-to-sync / pricing / channels; a value the scope doesn't set falls back to the
 * connection-level config (so legacy single-scope connections keep working unchanged).
 */
function resolveScopeConfig(connection, scope) {
    const base = connection.config || {};
    const out = {};
    for (const k of SCOPE_CONFIG_KEYS) {
        out[k] = scope[k] !== undefined ? scope[k] : base[k];
    }
    return out;
}

/**
 * Runs the full push pipeline (match → create → stock → content/price → images/publish) for ONE
 * scope target at ONE location. Connection-wide state (the product map, the run job, the
 * accumulating counts/errors/unmatched/staleSkus) is passed in and mutated, so several scopes in
 * one run share one map read, one job, and one set of counts. SKUs are disjoint across scopes
 * (Patrik SKUs vs feed SKUs), so each scope only touches its own rows.
 */
async function runScopeTarget({ connection, token, job, scopedProducts, items, locationId, exportConfig, existingMap, counts, errors, unmatched, staleSkus }) {
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
        // Accumulate across scopes (this fn runs once per scope target in a multi-source run).
        counts.matched += pushable.length;
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
                    connection, token, scopedProducts: imageProducts, matchInfoBySku, existingMap, counts, errors, staleSkus, unmatched,
                    // portal_authoritative re-adds images deleted in Shopify; handoff only fills new products.
                    authoritative: connection.config.ownership === 'portal_authoritative'
                });
            }
        }

}

/**
 * Executes a sync for a connection across ALL its scope targets. Caller passes the pre-created
 * run (job) so the HTTP layer can return its id immediately; this function fills in the result.
 *
 * Each scope is resolved to its source ({@link buildScope} / {@link buildExternalScope}) and its
 * own location, then run through {@link runScopeTarget}. The product map is read once and the
 * deleted-in-store pre-flight runs once (both are connection-wide); counts/errors/unmatched and
 * the stale-SKU set accumulate across scopes into the single job.
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
        const scopeList = getScopeList(connection);
        if (!scopeList.length) {
            throw Object.assign(new Error('No "Products to sync" source selected'), { code: 'NO_EXPORT_CONFIG' });
        }

        // Build each scope target: resolve its source (products + items) and validate its location.
        // A bad scope (no location / missing export config) is recorded and skipped so the OTHER
        // scopes still sync — one misconfigured source can't block the rest.
        const targets = [];
        for (const sc of scopeList) {
            if (!sc.locationId) {
                errors.push({ error: `No Shopify location selected for ${scopeLabel(sc)}` });
                continue;
            }
            try {
                // `exportConfig` is consumed downstream ONLY by tag resolution + the create phase.
                // Own-source products carry pre-resolved tags + vendor, so it stays null for feeds.
                let exportConfig = null;
                let built;
                if (sc.type === 'own_source') {
                    built = await buildExternalScope(sc.feedId);
                } else {
                    exportConfig = await getExportConfigById(sc.exportConfigId);
                    if (!exportConfig) {
                        errors.push({ error: `The export configuration for ${scopeLabel(sc)} no longer exists` });
                        continue;
                    }
                    built = await buildScope(exportConfig);
                }
                targets.push({ ...sc, exportConfig, scopedProducts: built.products, items: built.items });
            } catch (e) {
                errors.push({ error: `Could not build ${scopeLabel(sc)}: ${e.message}` });
            }
        }

        counts.inScope = targets.reduce((n, t) => n + t.items.length, 0);

        if (!targets.length) {
            // Every scope was misconfigured — finish as failed with the per-scope errors.
            await syncJobs.finishRun(job._id, { status: 'failed', counts, unmatched, errors, error: errors[0]?.error });
            await connectionService.updateLastSync(connection._id, { lastSyncStatus: 'failed' });
            return;
        }
        if (counts.inScope === 0) {
            const status = errors.length ? 'partial' : 'done';
            await syncJobs.finishRun(job._id, { status, counts, unmatched, errors });
            await connectionService.updateLastSync(connection._id, { lastSyncStatus: errors.length ? 'failed' : 'done' });
            return;
        }

        // Authoritative map: only look up SKUs we haven't mapped before (design §7). Read ONCE and
        // shared across scopes (their SKUs are disjoint, so each scope only touches its own rows).
        const existingMap = await productMap.getMapBySku(connection._id);

        // Pre-flight: drop mappings whose Shopify product was DELETED in the store. One bulk
        // existence check up front means those SKUs become unmapped and flow into the normal
        // match → create path THIS run (re-created instead of erroring on push and forcing a
        // second sync). Reactive stale-handling at push time remains a backstop.
        const mappedProductIds = [...new Set([...existingMap.values()].map((r) => r.shopifyProductId).filter(Boolean))];
        if (mappedProductIds.length) {
            try {
                const existing = await findExistingIds(connection.shopDomain, token, mappedProductIds);
                const deletedSkus = [];
                for (const [sku, row] of existingMap) {
                    if (row.shopifyProductId && !existing.has(row.shopifyProductId)) deletedSkus.push(sku);
                }
                if (deletedSkus.length) {
                    await productMap.deleteBySkus(connection._id, deletedSkus);
                    for (const sku of deletedSkus) existingMap.delete(sku);
                    console.log(`[shopify] pre-flight dropped ${deletedSkus.length} mapping(s) for deleted products (${connection.shopDomain})`);
                }
            } catch (err) {
                // Non-fatal — fall back to reactive stale handling at push time.
                console.error('[shopify] pre-flight existence check failed:', err.message);
            }
        }

        // Run each scope target at its own location AND its own push config, accumulating into the
        // shared run state. Each source gets an "effective connection" — the real connection with
        // its config swapped for the scope's effective config and the scope's location — so every
        // downstream push helper (which reads `connection.config.*`) works unchanged.
        for (const t of targets) {
            if (!t.items.length) continue;
            const scopeConn = { ...connection, config: resolveScopeConfig(connection, t), shopifyLocationId: t.locationId };
            // Per-source AI-categorization for tags: override the export config's aiExportId when
            // the scope sets one (Patrik sources). Own-source feeds carry pre-resolved tags.
            const tagExportConfig = (t.exportConfig && t.aiExportId)
                ? { ...t.exportConfig, filters: { ...(t.exportConfig.filters || {}), aiExportId: t.aiExportId } }
                : t.exportConfig;
            await runScopeTarget({
                connection: scopeConn, token, job,
                scopedProducts: t.scopedProducts, items: t.items, locationId: t.locationId, exportConfig: tagExportConfig,
                existingMap, counts, errors, unmatched, staleSkus
            });
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

/**
 * Fans the Shopify push out across every connection whose scope is a given Own Source feed —
 * called by the importer after a feed re-imports so its change propagates to consuming stores.
 * Each run is started in the background (serialized per shop); never throws.
 * @param {string} feedId
 * @param {{ trigger?: string }} [opts]
 */
async function syncConnectionsForFeed(feedId, { trigger = 'feed' } = {}) {
    const connections = await connectionService.listConnectionsForFeed(feedId);
    const results = [];
    for (const conn of connections) {
        try {
            const job = await startStockSync(conn._id, { trigger });
            results.push({ shop: conn.shopDomain, jobId: job._id.toString() });
        } catch (err) {
            results.push({ shop: conn.shopDomain, skipped: err.code || err.message });
        }
    }
    return results;
}

module.exports = {
    startStockSync,
    syncAllConnections,
    syncConnectionsForFeed,
    // exported for tests / future triggers (PNV delta, n8n reconcile)
    executeRun,
    getScopeList,
    resolveScopeConfig,
    buildScope,
    buildExternalScope,
    resolvePushPrice,
    pushNewProducts,
    pushImages
};
