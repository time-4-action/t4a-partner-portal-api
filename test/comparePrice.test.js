const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeCompareAtPricelist, normalizePriceFields, normalizeExistingSalePolicy,
    wantedFields, applySalePolicy, priceHashInput
} = require('../src/services/shopify/comparePrice.util');

test('normalizers fall back to the safe default', () => {
    assert.equal(normalizeCompareAtPricelist('  RRP 2025 '), 'RRP 2025');
    assert.equal(normalizeCompareAtPricelist('   '), null);
    assert.equal(normalizeCompareAtPricelist(42), null);
    assert.equal(normalizePriceFields('price_only'), 'price_only');
    assert.equal(normalizePriceFields('bogus'), 'price_and_compare_at');
    assert.equal(normalizeExistingSalePolicy('leave'), 'leave');
    assert.equal(normalizeExistingSalePolicy(undefined), 'overwrite');
});

test('wantedFields: no compare-at list means price only, whatever priceFields says', () => {
    assert.deepEqual(wantedFields({ compareAtPricelist: null, priceFields: 'price_and_compare_at' }), { wantP: true, wantC: false });
    assert.deepEqual(wantedFields({ compareAtPricelist: null, priceFields: 'compare_at_only' }), { wantP: false, wantC: false });
    assert.deepEqual(wantedFields(undefined), { wantP: true, wantC: false });
});

test('wantedFields with a compare-at list', () => {
    const list = 'RRP 2025';
    assert.deepEqual(wantedFields({ compareAtPricelist: list, priceFields: 'price_and_compare_at' }), { wantP: true, wantC: true });
    assert.deepEqual(wantedFields({ compareAtPricelist: list, priceFields: 'price_only' }), { wantP: true, wantC: false });
    assert.deepEqual(wantedFields({ compareAtPricelist: list, priceFields: 'compare_at_only' }), { wantP: false, wantC: true });
});

test('applySalePolicy is a passthrough without a merchant-made sale', () => {
    assert.deepEqual(applySalePolicy({ wantP: true, wantC: true }, 'leave', false), { wantP: true, wantC: true, skipped: false });
});

test('applySalePolicy narrows the fields on a merchant-made sale', () => {
    const both = { wantP: true, wantC: true };
    assert.deepEqual(applySalePolicy(both, 'overwrite', true), { wantP: true, wantC: true, skipped: false });
    assert.deepEqual(applySalePolicy(both, 'leave', true), { wantP: false, wantC: false, skipped: true });
    assert.deepEqual(applySalePolicy(both, 'price_only', true), { wantP: true, wantC: false, skipped: false });
    assert.deepEqual(applySalePolicy(both, 'compare_at_only', true), { wantP: false, wantC: true, skipped: false });
    assert.deepEqual(applySalePolicy(both, 'nonsense', true), { wantP: true, wantC: true, skipped: false });
    assert.equal(applySalePolicy({ wantP: true, wantC: false }, 'compare_at_only', true).skipped, true);
});

test('priceHashInput distinguishes unmanaged from cleared compare-at', () => {
    const unmanaged = priceHashInput({ price: '10.00' });
    const cleared = priceHashInput({ price: '10.00', compareAt: null });
    const set = priceHashInput({ price: '10.00', compareAt: '12.00' });
    assert.notEqual(unmanaged, cleared);
    assert.notEqual(cleared, set);
    assert.equal(unmanaged, priceHashInput({ price: '10.00', compareAt: undefined }));
});
