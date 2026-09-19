/**
 * Offline assertions for the compare-at price + existing-sale policy (progress doc §9).
 * No DB, no store — the mongo module only needs the env vars to exist at require time.
 *
 *   node scripts/scratch-compare-at.js
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
process.env.MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'scratch';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'scratch';

const assert = require('assert');
const crypto = require('crypto');
const cp = require('../src/services/shopify/comparePrice.util');
const { resolvePriceOpts, resolvePushPrice, resolvePushCompareAt, resolveCreatePrices } = require('../src/services/shopify/shopifySync.service');

let n = 0;
const ok = (cond, msg) => { assert(cond, msg); n++; };
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ── normalizers ──────────────────────────────────────────────────────────────
ok(cp.normalizeCompareAtPricelist(undefined) === null, 'undefined list → null');
ok(cp.normalizeCompareAtPricelist('  ') === null, 'blank list → null');
ok(cp.normalizeCompareAtPricelist(' RRP 2026 ') === 'RRP 2026', 'list trimmed');
ok(cp.normalizeCompareAtPricelist(42) === null, 'non-string list → null');
ok(cp.normalizePriceFields('garbage') === 'price_and_compare_at', 'bad fields → default');
ok(cp.normalizePriceFields('compare_at_only') === 'compare_at_only', 'valid fields kept');
ok(cp.normalizeExistingSalePolicy(null) === 'overwrite', 'missing policy → overwrite');
ok(cp.normalizeExistingSalePolicy('leave') === 'leave', 'valid policy kept');

// ── wantedFields ─────────────────────────────────────────────────────────────
ok(JSON.stringify(cp.wantedFields({})) === '{"wantP":true,"wantC":false}', 'legacy cfg → price only');
ok(JSON.stringify(cp.wantedFields({ compareAtPricelist: null, priceFields: 'compare_at_only' })) === '{"wantP":false,"wantC":false}', 'no list + compare_at_only → nothing');
ok(JSON.stringify(cp.wantedFields({ compareAtPricelist: 'RRP', priceFields: 'price_and_compare_at' })) === '{"wantP":true,"wantC":true}', 'list + both');
ok(JSON.stringify(cp.wantedFields({ compareAtPricelist: 'RRP', priceFields: 'price_only' })) === '{"wantP":true,"wantC":false}', 'list + price_only');
ok(JSON.stringify(cp.wantedFields({ compareAtPricelist: 'RRP', priceFields: 'compare_at_only' })) === '{"wantP":false,"wantC":true}', 'list + compare_at_only');

// ── applySalePolicy matrix ───────────────────────────────────────────────────
const M = {
    // policy → [wantP, wantC, skipped] for input {wantP:true, wantC:true} when hasSale
    overwrite: [true, true, false],
    leave: [false, false, true],
    price_only: [true, false, false],
    compare_at_only: [false, true, false]
};
for (const [policy, exp] of Object.entries(M)) {
    const r = cp.applySalePolicy({ wantP: true, wantC: true }, policy, true);
    ok(r.wantP === exp[0] && r.wantC === exp[1] && r.skipped === exp[2], `policy ${policy} on sale`);
    const r2 = cp.applySalePolicy({ wantP: true, wantC: true }, policy, false);
    ok(r2.wantP && r2.wantC && !r2.skipped, `policy ${policy} no sale → passthrough`);
}
ok(cp.applySalePolicy({ wantP: true, wantC: false }, 'compare_at_only', true).skipped === true, 'price-only cfg + compare_at_only policy → skipped');
ok(cp.applySalePolicy({ wantP: false, wantC: true }, 'price_only', true).skipped === true, 'compare-at-only cfg + price_only policy → skipped');
ok(cp.applySalePolicy({ wantP: true, wantC: false }, 'price_only', true).wantP === true, 'price-only cfg + price_only policy → price');

// ── hash input ───────────────────────────────────────────────────────────────
ok(cp.priceHashInput({ price: '10.00' }) !== cp.priceHashInput({ price: '10.00', compareAt: null }), 'unmanaged vs cleared differ');
ok(cp.priceHashInput({ price: '10.00', compareAt: null }) !== cp.priceHashInput({ price: '10.00', compareAt: '12.00' }), 'cleared vs set differ');
ok(cp.priceHashInput({ price: '10.00', compareAt: '12.00' }) === cp.priceHashInput({ price: '10.00', compareAt: '12.00' }), 'stable');
ok(sha1(cp.priceHashInput({ price: '10.00' })) !== sha1('10.00'), 'legacy sha1(price) rows re-push once (documented)');

// ── resolvers ────────────────────────────────────────────────────────────────
const now = Date.parse('2026-09-19T00:00:00Z');
const variant = {
    pricelist: [
        { name: 'Outlet', valid_from: '2026-01-01', price: 100, vat: 22 },
        { name: 'RRP 2026', valid_from: '2026-01-01', price: 150, vat: 22 },
        { name: 'RRP 2027', valid_from: '2027-01-01', price: 200, vat: 22 },
        { name: 'Net list', valid_from: '2026-01-01', price: 150, vat: 0 }
    ]
};
const prio = [{ name: 'Outlet', enabled: true, priority: 0 }, { name: 'RRP 2026', enabled: true, priority: 1 }];

let opts = resolvePriceOpts({ pricelistPriority: prio });
ok(resolvePushPrice(variant, opts, now) === '122.00', 'sell price gross');
ok(resolvePushCompareAt(variant, opts, now) === null, 'no list → null');
ok(opts.compareAtPricelist === null && opts.priceFields === 'price_and_compare_at' && opts.existingSalePolicy === 'overwrite', 'legacy opts defaults');

opts = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'RRP 2026' });
ok(resolvePushCompareAt(variant, opts, now) === '183.00', 'compare-at gross from named list');
ok(resolvePushCompareAt({ pricelist: [] }, opts, now) === null, 'empty pricelist → null');
ok(resolvePushCompareAt({}, opts, now) === null, 'no pricelist → null');

opts = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'RRP 2027' });
ok(resolvePushCompareAt(variant, opts, now) === null, 'future-dated list → null (guard on)');
opts = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'RRP 2027', futureDatedGuard: false });
ok(resolvePushCompareAt(variant, opts, now) === '244.00', 'future-dated list → value (guard off)');

opts = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'Net list', priceVatMode: 'exclusive' });
ok(resolvePushPrice(variant, opts, now) === '100.00' && resolvePushCompareAt(variant, opts, now) === '150.00', 'exclusive VAT both');
opts = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'Net list', priceVatMode: 'inclusive' });
ok(resolvePushCompareAt(variant, opts, now) === '150.00', 'inclusive VAT on a 0% list = net');

opts = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'RRP 2026', priceFactor: 2 });
ok(resolvePushPrice(variant, opts, now) === '244.00' && resolvePushCompareAt(variant, opts, now) === '366.00', 'factor applies to both');

// ── compare-at not above price → create path drops it ────────────────────────
const sameList = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'Outlet' });
ok(JSON.stringify(resolveCreatePrices(variant, sameList, now)) === '{"price":"122.00","compareAtPrice":null}', 'compare-at == price → null on create');
const good = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'RRP 2026' });
ok(JSON.stringify(resolveCreatePrices(variant, good, now)) === '{"price":"122.00","compareAtPrice":"183.00"}', 'create carries compare-at');
const caOnly = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'RRP 2026', priceFields: 'compare_at_only' });
ok(JSON.stringify(resolveCreatePrices(variant, caOnly, now)) === '{"price":"122.00","compareAtPrice":"183.00"}', 'compare_at_only still creates with a price');
const pOnly = resolvePriceOpts({ pricelistPriority: prio, compareAtPricelist: 'RRP 2026', priceFields: 'price_only' });
ok(JSON.stringify(resolveCreatePrices(variant, pOnly, now)) === '{"price":"122.00","compareAtPrice":null}', 'price_only creates without compare-at');
ok(JSON.stringify(resolveCreatePrices({ pricelist: [] }, good, now)) === '{"price":"0.00","compareAtPrice":null}', 'no price → 0.00 and no compare-at');

// ── rounding collapse ────────────────────────────────────────────────────────
const v2 = { pricelist: [{ name: 'A', price: 2031, vat: 0 }, { name: 'B', price: 2035, vat: 0 }] };
const rounded = resolvePriceOpts({
    pricelistPriority: [{ name: 'A', enabled: true, priority: 0 }],
    compareAtPricelist: 'B',
    priceRounding: { enabled: true, mode: 'up', step: 10, offset: 9 }
});
ok(resolvePushPrice(v2, rounded, now) === '2039.00' && resolvePushCompareAt(v2, rounded, now) === '2039.00', 'both snap to 2039');
ok(resolveCreatePrices(v2, rounded, now).compareAtPrice === null, 'rounding collapse → no compare-at');

console.log(`compare-at scratch: ${n} assertions passed`);

// ── Phase C drift + policy loop, with the store and the map stubbed ──────────
// `graphqlRequest` is destructured by the sync service at require time, so the stub has to be on
// the graphql module's export object BEFORE the sync service is required — hence the fresh cache.
(async () => {
    for (const k of Object.keys(require.cache)) if (/shopify(Sync|Graphql|ProductMap)\.service/.test(k)) delete require.cache[k];
    const gql = require('../src/services/shopify/shopifyGraphql.service');
    const pm = require('../src/services/shopify/shopifyProductMap.service');
    let live = new Map();
    const sent = [];
    gql.graphqlRequest = async (shop, token, query, vars) => {
        if (query.startsWith('query VariantPrices')) {
            if (live === 'FAIL') throw new Error('boom');
            return { nodes: vars.ids.map((id) => (live.has(id) ? { id, ...live.get(id) } : null)) };
        }
        if (query.startsWith('mutation VariantsPrice')) { sent.push(vars); return { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } }; }
        throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    };
    const hashed = [];
    pm.bulkSetHashes = async (_cid, updates) => { hashed.push(...updates); };
    const sync = require('../src/services/shopify/shopifySync.service');

    const product = { code: 'P1', product_name: 'P', child_products: [
        { code: 'S1', pricelist: [{ name: 'Outlet', price: 100, vat: 0 }, { name: 'RRP', price: 150, vat: 0 }] },
        { code: 'S2', pricelist: [{ name: 'Outlet', price: 100, vat: 0 }, { name: 'RRP', price: 150, vat: 0 }] }
    ] };
    const matchInfoBySku = new Map([
        ['S1', { shopifyProductId: 'gid://p/1', shopifyVariantId: 'gid://v/1' }],
        ['S2', { shopifyProductId: 'gid://p/1', shopifyVariantId: 'gid://v/2' }]
    ]);
    const base = { pricelistPriority: [{ name: 'Outlet', enabled: true, priority: 0 }], priceVatMode: 'exclusive', syncPrices: true };

    async function run(cfg, liveMap, existing = new Map(), products = [product]) {
        live = liveMap; sent.length = 0; hashed.length = 0;
        const counts = { pricesPushed: 0, compareAtPushed: 0, salesLeft: 0, failed: 0 };
        const errors = [];
        await sync.pushPortalAuthoritative({
            connection: { _id: 'c', shopDomain: 'x.myshopify.com', config: { ...base, ...cfg } },
            token: 't', scopedProducts: products, matchInfoBySku, existingMap: existing, exportConfig: null,
            counts, errors, staleSkus: new Set(), unmatched: [], pricesOnly: true
        });
        return { counts, errors, sent: sent.flatMap((s) => s.variants), hashed };
    }
    const L = (p1, c1, p2, c2) => new Map([['gid://v/1', { price: p1, compareAtPrice: c1 }], ['gid://v/2', { price: p2, compareAtPrice: c2 }]]);

    // legacy: no compare-at list → payload has only price, merchant sale untouched
    let r = await run({}, L('90.00', '120.00', '100.00', null));
    ok(r.sent.length === 1 && r.sent[0].id === 'gid://v/1' && r.sent[0].price === '100.00' && !('compareAtPrice' in r.sent[0]), 'legacy: price-only payload, no compareAtPrice key');
    ok(r.hashed.length === 1 && r.hashed[0].lastCompareAt === undefined, 'legacy: no lastCompareAt written');

    // feature on, overwrite: both pushed; stale merchant compare-at replaced
    r = await run({ compareAtPricelist: 'RRP' }, L('100.00', '120.00', '100.00', '150.00'));
    ok(r.sent.length === 1 && r.sent[0].compareAtPrice === '150.00' && r.sent[0].price === '100.00', 'overwrite: merchant 120 → 150');
    ok(r.counts.compareAtPushed === 1 && r.hashed[0].lastCompareAt === '150.00', 'overwrite: counted + lastCompareAt persisted');

    // feature on, no drift → nothing sent
    r = await run({ compareAtPricelist: 'RRP' }, L('100.00', '150.00', '100.00', '150.00'));
    ok(r.sent.length === 0, 'no drift → nothing sent');

    // feature on, list missing for variant → compareAtPrice: null clears
    const noList = { ...product, child_products: [{ code: 'S1', pricelist: [{ name: 'Outlet', price: 100, vat: 0 }] }] };
    r = await run({ compareAtPricelist: 'RRP' }, L('100.00', '150.00', '100.00', null), new Map(), [noList]);
    ok(r.sent.length === 1 && r.sent[0].compareAtPrice === null && r.hashed[0].lastCompareAt === null, 'feature on + unresolvable → null sent (clears), lastCompareAt null');

    // leave: merchant sale (120 ≠ ours) → skipped, other variant still pushed
    r = await run({ compareAtPricelist: 'RRP', existingSalePolicy: 'leave' }, L('90.00', '120.00', '100.00', null));
    ok(r.counts.salesLeft === 1 && r.sent.length === 1 && r.sent[0].id === 'gid://v/2' && r.sent[0].compareAtPrice === '150.00', 'leave: v1 skipped, v2 pushed');

    // leave: live compare-at == what portal last pushed → NOT a merchant sale → price drift corrected
    r = await run({ compareAtPricelist: 'RRP', existingSalePolicy: 'leave' }, L('90.00', '150.00', '100.00', '150.00'), new Map([['S1', { lastCompareAt: '150.00' }]]));
    ok(r.counts.salesLeft === 0 && r.sent.length === 1 && r.sent[0].price === '100.00', 'leave: own compare-at is not a sale');

    // leave: portal previously CLEARED (lastCompareAt null), merchant re-added → sale
    r = await run({ compareAtPricelist: 'RRP', existingSalePolicy: 'leave' }, L('100.00', '150.00', '100.00', '150.00'), new Map([['S1', { lastCompareAt: null }]]));
    ok(r.counts.salesLeft === 1, 'leave: lastCompareAt null + live 150 → merchant sale');

    // leave: no lastCompareAt row (legacy) but live == candidate → not a sale
    r = await run({ compareAtPricelist: 'RRP', existingSalePolicy: 'leave' }, L('90.00', '150.00', '100.00', '150.00'));
    ok(r.counts.salesLeft === 0 && r.sent.length === 1, 'leave: legacy row, live == candidate → not a sale');

    // leave + feature off: any live compare-at is merchant's → skip
    r = await run({ existingSalePolicy: 'leave' }, L('90.00', '120.00', '90.00', null));
    ok(r.counts.salesLeft === 1 && r.sent.length === 1 && r.sent[0].id === 'gid://v/2' && !('compareAtPrice' in r.sent[0]), 'leave + feature off: sale skipped, other price-only');

    // price_only policy: sale kept, price corrected, compare-at key absent
    r = await run({ compareAtPricelist: 'RRP', existingSalePolicy: 'price_only' }, L('90.00', '120.00', '100.00', '150.00'));
    ok(r.sent.length === 1 && r.sent[0].price === '100.00' && !('compareAtPrice' in r.sent[0]), 'price_only: price pushed, compare-at untouched');
    ok(r.hashed[0].lastCompareAt === undefined, 'price_only: lastCompareAt not overwritten');

    // compare_at_only policy: price kept (live 90), compare-at floor = live price → 150 > 90 sent
    r = await run({ compareAtPricelist: 'RRP', existingSalePolicy: 'compare_at_only' }, L('90.00', '120.00', '100.00', '150.00'));
    ok(r.sent.length === 1 && !('price' in r.sent[0]) && r.sent[0].compareAtPrice === '150.00', 'compare_at_only policy: only compare-at');

    // priceFields compare_at_only + live price ABOVE compare-at → floor is live → null
    r = await run({ compareAtPricelist: 'RRP', priceFields: 'compare_at_only' }, L('200.00', '150.00', '100.00', '150.00'));
    ok(r.sent.length === 1 && r.sent[0].id === 'gid://v/1' && r.sent[0].compareAtPrice === null && !('price' in r.sent[0]), 'compare_at_only fields: live price is the floor → cleared');

    // priceFields price_only: compare-at never touched
    r = await run({ compareAtPricelist: 'RRP', priceFields: 'price_only' }, L('90.00', '120.00', '100.00', null));
    ok(r.sent.length === 1 && !('compareAtPrice' in r.sent[0]), 'price_only fields: no compareAtPrice key');

    // live fetch fails + leave → skipped with error, nothing sent
    r = await run({ compareAtPricelist: 'RRP', existingSalePolicy: 'leave' }, 'FAIL');
    ok(r.sent.length === 0 && r.errors.length === 1 && /skipped/.test(r.errors[0].error), 'fetch fail + leave → skip run');

    // live fetch fails + overwrite → hash gate: no row → pushes; matching row → no push
    r = await run({ compareAtPricelist: 'RRP' }, 'FAIL');
    ok(r.sent.length === 2 && r.sent[0].compareAtPrice === '150.00', 'fetch fail + overwrite → hash-gate push');
    const h = r.hashed.find((x) => x.sku === 'S1').priceHash;
    r = await run({ compareAtPricelist: 'RRP' }, 'FAIL', new Map([['S1', { priceHash: h }]]));
    ok(r.sent.length === 1 && r.sent[0].id === 'gid://v/2', 'fetch fail + overwrite + matching hash → S1 not re-pushed');

    console.log(`compare-at scratch (incl. Phase C loop): ${n} assertions passed total`);
})().catch((e) => { console.error(e); process.exit(1); });
