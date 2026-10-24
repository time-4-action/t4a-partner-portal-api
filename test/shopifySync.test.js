const { test } = require('node:test');
const assert = require('node:assert/strict');

// The sync engine pulls in the Mongo and Anthropic modules, which refuse to load without these.
// Dummy values only: nothing here connects or calls out (MongoClient connects lazily).
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:1';
process.env.MONGO_DB_NAME ??= 'test';
process.env.ANTHROPIC_API_KEY ??= 'test';

const sync = require('../src/services/shopify/shopifySync.service');

const NOW = Date.parse('2026-10-24T12:00:00Z');
const opts = (cfg = {}) => sync.resolvePriceOpts(cfg);
const priority = (...names) => names.map((name, i) => ({ name, priority: i + 1, enabled: true }));

test('getScopeList drops disabled scopes, filters by id, defaults the location', () => {
    const connection = {
        shopifyLocationId: 'L0',
        config: {
            scopes: [
                { id: 'a', type: 'export_config', exportConfigId: 'e1' },
                { id: 'b', type: 'own_source', feedId: 'f1', locationId: 'L2' },
                { id: 'c', type: 'own_source', feedId: 'f2', enabled: false }
            ]
        }
    };
    assert.deepEqual(sync.getScopeList(connection).map((s) => [s.id, s.locationId]), [['a', 'L0'], ['b', 'L2']]);
    assert.deepEqual(sync.getScopeList(connection, { scopeIds: ['b'] }).map((s) => s.id), ['b']);
    assert.deepEqual(sync.getScopeList(connection, { includeDisabled: true }).map((s) => s.id), ['a', 'b', 'c']);
});

test('getScopeList reads the legacy single-scope config', () => {
    assert.deepEqual(
        sync.getScopeList({ shopifyLocationId: 'L0', config: { exportConfigId: 'e1' } }),
        [{ type: 'export_config', exportConfigId: 'e1', locationId: 'L0' }]
    );
    assert.deepEqual(sync.getScopeList({ config: {} }), []);
});

test('resolveScopeConfig: the scope wins, an unset key falls back to the connection', () => {
    const cfg = sync.resolveScopeConfig(
        { config: { ownership: 'stock_only', syncTags: true, priceFactor: 2 } },
        { ownership: 'portal_authoritative', syncTags: false }
    );
    assert.equal(cfg.ownership, 'portal_authoritative');
    assert.equal(cfg.syncTags, false);
    assert.equal(cfg.priceFactor, 2);
    assert.equal(cfg.titlePrefix, undefined);
});

test('resolvePriceOpts sanitizes every setting', () => {
    const o = opts({ priceFactor: '0', priceRounding: { enabled: true, mode: 'bogus' }, priceFields: 'x', compareAtPricelist: ' ' });
    assert.equal(o.factor, 1);
    assert.equal(o.rounding.enabled, false);
    assert.equal(o.priceFields, 'price_and_compare_at');
    assert.equal(o.compareAtPricelist, null);
    assert.equal(o.vatMode, 'inclusive');
    assert.equal(o.futureGuard, true);
    assert.equal(o.existingSalePolicy, 'overwrite');
});

const variant = {
    code: 'V1',
    pricelist: [
        { name: 'RRP 2025', price: 100, vat: 22, valid_from: '2025-01-01' },
        { name: 'RRP 2026', price: 200, vat: 0, valid_from: '2099-01-01' }
    ]
};

test('resolvePushPrice: future-dated guard, VAT mode, factor then rounding', () => {
    const base = { pricelistPriority: priority('RRP 2026', 'RRP 2025') };
    assert.equal(sync.resolvePushPrice(variant, opts(base), NOW), '122.00');
    assert.equal(sync.resolvePushPrice(variant, opts({ ...base, priceVatMode: 'exclusive' }), NOW), '100.00');
    assert.equal(sync.resolvePushPrice(variant, opts({ ...base, futureDatedGuard: false }), NOW), '200.00');
    assert.equal(sync.resolvePushPrice(variant, opts({ ...base, priceFactor: 11.4 }), NOW), '1390.80');
    assert.equal(sync.resolvePushPrice(variant, opts({
        ...base, priceFactor: 11.4, priceRounding: { enabled: true, mode: 'up', step: 10, offset: 9 }
    }), NOW), '1399.00');
    assert.equal(sync.resolvePushPrice({ code: 'X', pricelist: [] }, opts(base), NOW), null);
});

test('resolvePushCompareAt reads only the named list', () => {
    assert.equal(sync.resolvePushCompareAt(variant, opts({ compareAtPricelist: 'RRP 2025' }), NOW), '122.00');
    assert.equal(sync.resolvePushCompareAt(variant, opts({ compareAtPricelist: 'Missing' }), NOW), null);
    assert.equal(sync.resolvePushCompareAt(variant, opts({ compareAtPricelist: 'RRP 2026' }), NOW), null);
    assert.equal(sync.resolvePushCompareAt(variant, opts({}), NOW), null);
});

test('resolveCreatePrices sends a compare-at only when it is above the price', () => {
    const v = { pricelist: [{ name: 'Sale', price: 80, vat: 0 }, { name: 'RRP', price: 100, vat: 0 }] };
    const cfg = { pricelistPriority: priority('Sale'), priceVatMode: 'exclusive', compareAtPricelist: 'RRP' };
    assert.deepEqual(sync.resolveCreatePrices(v, opts(cfg), NOW), { price: '80.00', compareAtPrice: '100.00' });
    const notASale = { pricelist: [{ name: 'Sale', price: 100, vat: 0 }, { name: 'RRP', price: 100, vat: 0 }] };
    assert.deepEqual(sync.resolveCreatePrices(notASale, opts(cfg), NOW), { price: '100.00', compareAtPrice: null });
    assert.deepEqual(sync.resolveCreatePrices({ pricelist: [] }, opts(cfg), NOW), { price: '0.00', compareAtPrice: null });
});

test('applyTitlePrefix prepends once and never stacks', () => {
    assert.equal(sync.applyTitlePrefix('Naish Foil', 'WINDSURF -'), 'WINDSURF - Naish Foil');
    assert.equal(sync.applyTitlePrefix('WINDSURF - Naish Foil', 'WINDSURF -'), 'WINDSURF - Naish Foil');
    assert.equal(sync.applyTitlePrefix('Harness', '{vendor} -', { vendor: 'Dakine' }), 'Dakine - Harness');
    assert.equal(sync.applyTitlePrefix('Dakine Harness', '{vendor} -', { vendor: 'Dakine' }), 'Dakine Harness');
    assert.equal(sync.applyTitlePrefix('Board', '{vendor} -', {}), 'Patrik International - Board');
    assert.equal(sync.applyTitlePrefix('Board', '{category} -', {}), 'Board');
    assert.equal(sync.applyTitlePrefix('Board', '  '), 'Board');
});

test('resolveOptionValues: size, then the name, disambiguating collisions', () => {
    const sku = (v) => v.code;
    const sized = [
        { code: 'A', size: '72', product_name: 'Patrik T-Wave 72 l' },
        { code: 'B', size: '72', product_name: 'Patrik T-Wave 72 l - GBM' },
        { code: 'C', size: '75', product_name: 'Patrik T-Wave 75 l' }
    ];
    assert.deepEqual([...sync.resolveOptionValues(sized, sku)], [['A', '72'], ['B', '72 GBM'], ['C', '75']]);

    const wings = [
        { code: 'W1', product_name: 'Patrik Foil Front Wing 500 cm2' },
        { code: 'W2', product_name: 'Patrik Foil Front Wing 700 cm2' }
    ];
    assert.deepEqual([...sync.resolveOptionValues(wings, sku)], [['W1', '500 cm2'], ['W2', '700 cm2']]);

    const twins = [{ code: 'T1', size: '68', product_name: 'Same' }, { code: 'T2', size: '68', product_name: 'Same' }];
    assert.deepEqual([...sync.resolveOptionValues(twins, sku)], [['T1', '68'], ['T2', '68 (2)']]);
});

test('planOptionValueRepair renames only values that are one of our SKUs', () => {
    const product = {
        code: 'P', product_name: 'Patrik Foil Front Wing',
        child_products: [
            { code: 'W1', product_name: 'Patrik Foil Front Wing 500 cm2' },
            { code: 'W2', product_name: 'Patrik Foil Front Wing 700 cm2' }
        ]
    };
    const node = {
        id: 'gid://shopify/Product/1',
        options: [{ id: 'O1', position: 1, name: 'Size', optionValues: [{ id: 'v1', name: 'W1' }, { id: 'v2', name: 'Custom' }] }]
    };
    assert.deepEqual(sync.planOptionValueRepair(node, product), {
        productId: 'gid://shopify/Product/1', optionId: 'O1', parentCode: 'P', updates: [{ id: 'v1', name: '500 cm2' }]
    });
    const title = { id: 'x', options: [{ id: 'O', position: 1, name: 'Title', optionValues: [{ id: 'v', name: 'W1' }] }] };
    assert.equal(sync.planOptionValueRepair(title, product), null);
    assert.equal(sync.planOptionValueRepair(null, product), null);
});

test('toFetchableUrl percent-encodes, leaves junk alone', () => {
    assert.equal(sync.toFetchableUrl('https://cdn.example.com/a b.jpg'), 'https://cdn.example.com/a%20b.jpg');
    assert.equal(sync.toFetchableUrl('not a url'), 'not a url');
});
