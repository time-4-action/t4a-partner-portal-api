const axios = require('axios');
const crypto = require('crypto');
const ownSource = require('./ownSource.service');
const externalProducts = require('./externalProducts.service');
const { validateFeed } = require('./feedValidator.service');
const { expandCategoryToTags } = require('../customExport.service');
const { decryptToken } = require('../shopify/crypto.service');
const queue = require('../shopify/shopifyQueue.service');

/**
 * The importer (design §6): fetch → validate → map canonical JSON 1:1 onto the internal product
 * shape → snapshot upsert → sweep → trigger the Shopify push. Imports are cheap (one fetch + one
 * bulk write), serialized per feed via the existing per-key queue. An invalid or erroring feed
 * NEVER mutates the catalogue (validate-before-write); the wipe-guard stops an upstream outage
 * from emptying a store.
 */

/** Hard caps for the feed fetch (a feed is small JSON; refuse pathological responses). */
const FETCH_TIMEOUT_MS = 30000;
const MAX_FEED_BYTES = 25 * 1024 * 1024;

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

/** A queue key so two imports of the same feed never overlap (mirrors per-shop serialization). */
const lockKey = (feedId) => `feed:${feedId}`;

/** True when an import is already running for this feed. */
function isBusy(feedId) {
    return queue.isBusy(lockKey(feedId));
}

/** Slugifies into a Shopify-handle-friendly token. */
function handleize(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Minimal HTML hardening for a supplier-supplied description: drop <script>/<style>/<iframe>
 * blocks and inline event handlers. Shopify sanitizes again on its side; this is a belt-and-braces
 * guard so nothing executable is ever stored.
 */
function sanitizeHtml(html) {
    if (!html) return '';
    return String(html)
        .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/javascript:/gi, '');
}

/**
 * Maps ONE validated feed product onto the internal `products` shape (design §4.2). Price is
 * normalized to NET (the portal's convention) here; the connection's VAT push mode is applied
 * later by the unchanged `resolvePushPrice`. Tags are pre-resolved (flat + expanded paths, §7).
 */
function mapProduct(feedProduct, { brand, generatedAt, feedId, defaultStatus }) {
    const status = feedProduct.status || defaultStatus || 'active';
    const published = status === 'active';
    const feedListName = `${brand} Feed`;

    const expanded = [...new Set((feedProduct.categoryPaths || []).flatMap(expandCategoryToTags))];
    const tags = [...new Set([...(feedProduct.tags || []), ...expanded])];

    const child_products = (feedProduct.variants || []).map((v) => {
        const vat = Number(v.price.vat) || 0;
        const net = v.price.taxMode === 'gross' ? v.price.amount / (1 + vat / 100) : v.price.amount;
        return {
            code: v.sku,
            ean_code: v.barcode || null,
            token: handleize(v.sku),
            product_name: feedProduct.name,
            size: v.option1 != null ? String(v.option1) : '',
            stock_amount: v.stock,
            published,
            images: v.image ? [v.image] : [],
            pricelist: [{ name: feedListName, valid_from: generatedAt, price: net, vat }]
        };
    });

    return {
        externalId: feedProduct.externalId,
        source: `own:${feedId}`,
        code: feedProduct.externalId,
        token: handleize(feedProduct.externalId) || handleize(feedProduct.name),
        product_name: feedProduct.name,
        detailed_description: sanitizeHtml(feedProduct.descriptionHtml),
        short_description: '',
        vendor: feedProduct.vendor || brand,
        categories: feedProduct.productType ? [feedProduct.productType] : [],
        images: (feedProduct.images || []).map((i) => i.src),
        published,
        active: true,
        stock_amount: 0,
        ean_code: null,
        child_products,
        pricelist: [],
        tags,
        contentHash: sha1(JSON.stringify({ name: feedProduct.name, desc: feedProduct.descriptionHtml || '', tags })),
        imageHash: sha1((feedProduct.images || []).map((i) => i.src).join('|'))
    };
}

/**
 * Fetches the feed body as text, attaching the optional auth header. Caps size + time.
 * Accepts the stored shape (`authTokenEnc`, encrypted) or a transient plaintext `authToken`
 * (used by the pre-save "Test feed" path before any secret is persisted).
 */
async function fetchFeed(feed) {
    const headers = {};
    if (feed.authHeaderName) {
        const token = feed.authToken != null ? feed.authToken : (feed.authTokenEnc ? decryptToken(feed.authTokenEnc) : null);
        if (token) headers[feed.authHeaderName] = token;
    }
    const res = await axios.get(feed.url, {
        headers,
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_FEED_BYTES,
        maxBodyLength: MAX_FEED_BYTES,
        responseType: 'text',
        transformResponse: [(d) => d], // keep raw text so the validator parses (precise errors)
        validateStatus: (s) => s >= 200 && s < 300
    });
    return res.data;
}

/**
 * Runs one import for a feed. Never throws — every outcome is recorded on the feed's `health`.
 * Returns a summary `{ ok, result, counts?, issues? }`.
 *
 * @param {string} feedId
 * @param {{ trigger?: string }} [opts]
 */
async function runImport(feedId, { trigger = 'manual' } = {}) {
    const startedAt = new Date();
    const source = await ownSource.getRawByFeedId(feedId);
    if (!source) return { ok: false, result: 'not_found' };
    if (source.status === 'paused') return { ok: false, result: 'paused' };

    const opts = source.options || {};
    const ownerSub = source.ownerSub;

    // 1+2. Fetch ───────────────────────────────────────────────────────────────
    let raw;
    try {
        raw = await fetchFeed(source.feed);
    } catch (err) {
        const message = err.response ? `HTTP ${err.response.status}` : err.message;
        const error = { code: 'FETCH_ERROR', message };
        await ownSource.recordHealth(feedId, { result: 'fetch_error', error });
        await ownSource.recordRun(feedId, ownerSub, { trigger, result: 'fetch_error', error, startedAt });
        return { ok: false, result: 'fetch_error', error: message };
    }

    // 3. Validate ────────────────────────────────────────────────────────────────
    const verdict = validateFeed(raw, { maxStalenessHours: opts.maxStalenessHours });
    if (!verdict.ok) {
        const error = { code: 'INVALID', message: `${verdict.issues.length} validation issue(s)`, issues: verdict.issues.slice(0, 50) };
        await ownSource.recordHealth(feedId, { result: 'invalid', touchValidate: true, error });
        await ownSource.recordRun(feedId, ownerSub, { trigger, result: 'invalid', error, startedAt });
        return { ok: false, result: 'invalid', issues: verdict.issues };
    }
    const feed = verdict.normalized;

    // 4. Wipe-guard ──────────────────────────────────────────────────────────────
    if (feed.products.length === 0 && !opts.allowEmptyFeed) {
        const error = { code: 'EMPTY_FEED', message: 'feed returned 0 products — wipe-guard held the catalogue (set allowEmptyFeed to override)' };
        await ownSource.recordHealth(feedId, { result: 'fetch_error', touchValidate: true, error });
        await ownSource.recordRun(feedId, ownerSub, { trigger, result: 'empty_guard', error, startedAt });
        return { ok: false, result: 'empty_guard' };
    }

    // 5. Map ───────────────────────────────────────────────────────────────────
    const importRunId = `imp_${crypto.randomBytes(6).toString('hex')}`;
    const mapped = feed.products.map((p) => mapProduct(p, {
        brand: source.brand, generatedAt: feed.generatedAt, feedId, defaultStatus: opts.defaultStatus
    }));

    // 6. Snapshot upsert + sweep ──────────────────────────────────────────────────
    const { created, updated } = await externalProducts.bulkUpsert(feedId, ownerSub, importRunId, mapped);
    const removed = await externalProducts.sweep(feedId, importRunId, opts.removalPolicy);

    const counts = { products: verdict.counts.products, variants: verdict.counts.variants, created, updated, removed };
    await ownSource.recordHealth(feedId, { result: 'ok', touchValidate: true, counts });
    await ownSource.recordRun(feedId, ownerSub, { trigger, result: 'ok', counts, startedAt });

    // 8. Trigger the Shopify push for any connection scoped to this feed (fire-and-forget).
    //    Required lazily to avoid a require cycle (shopifySync doesn't import this module).
    try {
        const syncService = require('../shopify/shopifySync.service');
        if (typeof syncService.syncConnectionsForFeed === 'function') {
            syncService.syncConnectionsForFeed(feedId, { trigger: `feed:${trigger}` }).catch(() => {});
        }
    } catch (e) {
        console.error('[external] post-import push trigger failed:', e.message);
    }

    return { ok: true, result: 'ok', counts };
}

/**
 * Test-only fetch + validate (NO write) — backs the "Test feed" UI (design §9.2). Returns the
 * validation verdict plus a small sample preview (first 3 products) so the user SEES what would
 * be pushed before committing. `feed` is `{ url, authHeaderName?, authToken?|authTokenEnc? }`.
 */
async function testFeed(feed, { maxStalenessHours, connectionCurrency } = {}) {
    let raw;
    try {
        raw = await fetchFeed(feed);
    } catch (err) {
        const message = err.response ? `HTTP ${err.response.status}` : err.message;
        return { ok: false, fetchError: message, counts: { products: 0, variants: 0 }, issues: [], warnings: [], sample: [] };
    }
    const verdict = validateFeed(raw, { maxStalenessHours, connectionCurrency });
    const sample = verdict.ok
        ? verdict.normalized.products.slice(0, 3).map((p) => ({
              name: p.name,
              variants: (p.variants || []).length,
              price: p.variants?.[0]?.price?.amount ?? null,
              tags: [...(p.tags || []), ...(p.categoryPaths || [])]
          }))
        : [];
    return {
        ok: verdict.ok,
        counts: verdict.counts,
        generatedAt: verdict.ok ? verdict.normalized.generatedAt : null,
        issues: verdict.issues,
        warnings: verdict.warnings,
        sample
    };
}

/**
 * Public entry: starts an import under the per-feed lock and returns a promise for the summary.
 * Rejects fast (typed SYNC_BUSY) when one is already running for the feed.
 */
function startImport(feedId, opts = {}) {
    if (isBusy(feedId)) {
        return Promise.reject(Object.assign(new Error('An import is already running for this feed'), { code: 'SYNC_BUSY' }));
    }
    return queue.runExclusive(lockKey(feedId), () => runImport(feedId, opts));
}

module.exports = {
    startImport,
    runImport,
    testFeed,
    isBusy,
    // exported for tests / the "Test feed" controller path
    mapProduct,
    fetchFeed,
    sanitizeHtml
};
