const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFeed } = require('../src/services/external/feedValidator.service');

const NOW = Date.parse('2026-10-24T12:00:00Z');

function validFeed() {
    return {
        schemaVersion: '1.0',
        brand: 'Point-7',
        currency: 'EUR',
        generatedAt: '2026-10-24T10:00:00Z',
        products: [{
            externalId: 'P1',
            name: 'AC-1 Sail',
            descriptionHtml: '<p>Sail</p>',
            vendor: 'Point-7',
            productType: 'Sails',
            status: 'active',
            tags: ['sail'],
            categoryPaths: ['Windsurf / Sails'],
            images: [{ src: 'https://cdn.example.com/a.jpg', alt: 'A' }],
            variants: [
                { sku: 'P1-50', barcode: '383000000001', option1: '5.0', stock: 3, price: { amount: 899, vat: 22, taxMode: 'gross' } },
                { sku: 'P1-55', stock: 0, price: { amount: 949, vat: 22, taxMode: 'net' }, image: 'https://cdn.example.com/b.jpg' }
            ]
        }]
    };
}

const paths = (r) => r.issues.map((i) => i.path);

test('a valid feed passes, as an object and as a string', () => {
    for (const input of [validFeed(), JSON.stringify(validFeed())]) {
        const r = validateFeed(input, { nowMs: NOW });
        assert.equal(r.ok, true, JSON.stringify(r.issues));
        assert.deepEqual(r.counts, { products: 1, variants: 2 });
        assert.deepEqual(r.issues, []);
        assert.equal(r.normalized.brand, 'Point-7');
    }
});

test('an unknown field is rejected at its own path', () => {
    const f = validFeed();
    f.products[0].variants[1].colour = 'red';
    const r = validateFeed(f, { nowMs: NOW });
    assert.equal(r.ok, false);
    assert.deepEqual(paths(r), ['/products/0/variants/1/colour']);
    assert.match(r.issues[0].message, /unexpected property "colour"/);
});

test('an unknown top-level field points at the key, not "//key"', () => {
    const r = validateFeed({ ...validFeed(), extra: true }, { nowMs: NOW });
    assert.deepEqual(paths(r), ['/extra']);
});

test('a missing sku is rejected at the sku path', () => {
    const f = validFeed();
    delete f.products[0].variants[0].sku;
    const r = validateFeed(f, { nowMs: NOW });
    assert.deepEqual(paths(r), ['/products/0/variants/0/sku']);
    assert.match(r.issues[0].message, /missing required property "sku"/);
});

test('a missing top-level property points at the key', () => {
    const f = validFeed();
    delete f.brand;
    assert.deepEqual(paths(validateFeed(f, { nowMs: NOW })), ['/brand']);
});

test('a wrong schemaVersion is rejected with the allowed values', () => {
    const r = validateFeed({ ...validFeed(), schemaVersion: '2.0' }, { nowMs: NOW });
    assert.deepEqual(paths(r), ['/schemaVersion']);
    assert.match(r.issues[0].message, /"1\.0"/);
});

test('negative stock is rejected at the stock path', () => {
    const f = validFeed();
    f.products[0].variants[1].stock = -1;
    const r = validateFeed(f, { nowMs: NOW });
    assert.deepEqual(paths(r), ['/products/0/variants/1/stock']);
    assert.match(r.issues[0].message, />= 0/);
});

test('fractional stock and a negative price are rejected', () => {
    const f = validFeed();
    f.products[0].variants[0].stock = 1.5;
    f.products[0].variants[1].price.amount = -1;
    assert.deepEqual(paths(validateFeed(f, { nowMs: NOW })).sort(), [
        '/products/0/variants/0/stock', '/products/0/variants/1/price/amount'
    ]);
});

test('malformed JSON and non-object input', () => {
    assert.match(validateFeed('{nope', { nowMs: NOW }).issues[0].message, /^INVALID_JSON/);
    assert.equal(validateFeed('[]', { nowMs: NOW }).issues[0].message, 'feed must be a JSON object');
    assert.equal(validateFeed(null, { nowMs: NOW }).ok, false);
});

test('duplicate SKUs and externalIds are reported with the first occurrence', () => {
    const f = validFeed();
    f.products.push({ ...f.products[0], variants: [{ ...f.products[0].variants[0] }] });
    const r = validateFeed(f, { nowMs: NOW });
    assert.equal(r.ok, false);
    assert.deepEqual(paths(r), ['/products/1/externalId', '/products/1/variants/0/sku']);
    assert.match(r.issues[1].message, /first seen at \/products\/0\/variants\/0/);
});

test('http image URLs are rejected', () => {
    const f = validFeed();
    f.products[0].images[0].src = 'http://cdn.example.com/a.jpg';
    f.products[0].variants[1].image = 'http://cdn.example.com/b.jpg';
    assert.deepEqual(paths(validateFeed(f, { nowMs: NOW })), ['/products/0/images/0/src', '/products/0/variants/1/image']);
});

test('staleness and far-future generatedAt', () => {
    const stale = validateFeed({ ...validFeed(), generatedAt: '2026-10-20T00:00:00Z' }, { nowMs: NOW, maxStalenessHours: 48 });
    assert.deepEqual(paths(stale), ['/generatedAt']);
    assert.match(stale.issues[0].message, /stale/);
    const future = validateFeed({ ...validFeed(), generatedAt: '2026-10-30T00:00:00Z' }, { nowMs: NOW });
    assert.match(future.issues[0].message, /future/);
});

test('a currency mismatch is a warning, not an error', () => {
    const r = validateFeed(validFeed(), { nowMs: NOW, connectionCurrency: 'USD' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings.map((w) => w.path), ['/currency']);
});
