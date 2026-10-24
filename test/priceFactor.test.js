const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePriceFactor, toMoneyString, PRICE_FACTOR_MAX } = require('../src/services/shopify/priceFactor.util');

test('normalizePriceFactor defaults anything unusable to 1', () => {
    for (const raw of [null, undefined, '', 0, -2, 'abc', NaN, Infinity]) {
        assert.equal(normalizePriceFactor(raw), 1, `for ${String(raw)}`);
    }
});

test('normalizePriceFactor accepts comma decimals and keeps 6 dp', () => {
    assert.equal(normalizePriceFactor('11,4'), 11.4);
    assert.equal(normalizePriceFactor(' 1.5 '), 1.5);
    assert.equal(normalizePriceFactor(1.23456789), 1.234568);
});

test('normalizePriceFactor caps at PRICE_FACTOR_MAX', () => {
    assert.equal(normalizePriceFactor(1e12), PRICE_FACTOR_MAX);
});

test('toMoneyString rounds binary-float halves up', () => {
    assert.equal(toMoneyString(1.005), '1.01');
    assert.equal(toMoneyString(140.675), '140.68');
    assert.equal(toMoneyString(122), '122.00');
});

test('toMoneyString maps invalid or negative amounts to 0.00', () => {
    assert.equal(toMoneyString(-1), '0.00');
    assert.equal(toMoneyString(NaN), '0.00');
    assert.equal(toMoneyString(Infinity), '0.00');
});
