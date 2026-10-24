const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizePriceRounding, applyPriceRounding, describePriceRounding, DEFAULT_PRICE_ROUNDING
} = require('../src/services/shopify/priceRounding.util');

const rule = (r) => ({ enabled: true, alwaysAdvance: false, ...r });

test('end in 9: rounds up to the next …9', () => {
    const r = rule({ mode: 'up', step: 10, offset: 9 });
    assert.equal(applyPriceRounding(2031.99, r), 2039);
    assert.equal(applyPriceRounding(2039, r), 2039);
    assert.equal(applyPriceRounding(2039.01, r), 2049);
});

test('alwaysAdvance pushes a price already on the grid to the next step', () => {
    assert.equal(applyPriceRounding(2039, rule({ mode: 'up', step: 10, offset: 9, alwaysAdvance: true })), 2049);
    assert.equal(applyPriceRounding(2039, rule({ mode: 'down', step: 10, offset: 9, alwaysAdvance: true })), 2029);
});

test('end in .99 and whole-euro rules', () => {
    assert.equal(applyPriceRounding(2039.8, rule({ mode: 'up', step: 1, offset: 0.99 })), 2039.99);
    assert.equal(applyPriceRounding(12.01, rule({ mode: 'up', step: 1, offset: 0 })), 13);
    assert.equal(applyPriceRounding(12.99, rule({ mode: 'down', step: 1, offset: 0 })), 12);
});

test('nearest rounds half up', () => {
    const r = rule({ mode: 'nearest', step: 5, offset: 0 });
    assert.equal(applyPriceRounding(12.5, r), 15);
    assert.equal(applyPriceRounding(12.49, r), 10);
});

test('float noise from the factor does not jump a step', () => {
    assert.equal(applyPriceRounding(2039.0000000000002, rule({ mode: 'up', step: 1, offset: 0 })), 2039);
    assert.equal(applyPriceRounding(0.1 + 0.2, rule({ mode: 'up', step: 0.01, offset: 0 })), 0.3);
});

test('never returns zero or below — leaves the amount alone instead', () => {
    assert.equal(applyPriceRounding(5, rule({ mode: 'down', step: 10, offset: 9 })), 5);
    assert.equal(applyPriceRounding(0, rule({ mode: 'up', step: 10, offset: 9 })), 0);
    assert.equal(applyPriceRounding(-3, rule({ mode: 'up', step: 10, offset: 9 })), -3);
});

test('a disabled or broken rule is identity', () => {
    assert.equal(applyPriceRounding(2031.99, { enabled: false, mode: 'up', step: 10, offset: 9 }), 2031.99);
    assert.equal(applyPriceRounding(2031.99, rule({ mode: 'sideways', step: 10 })), 2031.99);
    assert.equal(applyPriceRounding(2031.99, rule({ mode: 'up', step: 100000 })), 2031.99);
    assert.equal(applyPriceRounding(2031.99, null), 2031.99);
});

test('normalizePriceRounding returns the defaults for junk input', () => {
    assert.deepEqual(normalizePriceRounding(null), DEFAULT_PRICE_ROUNDING);
    assert.deepEqual(normalizePriceRounding([]), DEFAULT_PRICE_ROUNDING);
    assert.deepEqual(normalizePriceRounding(rule({ mode: 'up', step: 0.001 })), DEFAULT_PRICE_ROUNDING);
});

test('normalizePriceRounding keeps the numbers of a switched-off rule', () => {
    assert.deepEqual(
        normalizePriceRounding({ enabled: false, mode: 'down', step: 5, offset: 1 }),
        { enabled: false, mode: 'down', step: 5, offset: 1, alwaysAdvance: false }
    );
});

test('normalizePriceRounding folds the offset into the step and parses commas', () => {
    assert.equal(normalizePriceRounding(rule({ mode: 'up', step: 10, offset: 19 })).offset, 9);
    assert.equal(normalizePriceRounding(rule({ mode: 'up', step: '1', offset: '0,99' })).offset, 0.99);
    assert.equal(normalizePriceRounding(rule({ mode: 'up', step: 10, offset: -4 })).offset, 0);
});

test('normalizePriceRounding forces alwaysAdvance off for nearest and keeps a fixed key order', () => {
    const r = normalizePriceRounding({ alwaysAdvance: true, offset: 0, step: 5, mode: 'nearest', enabled: true });
    assert.equal(r.alwaysAdvance, false);
    assert.deepEqual(Object.keys(r), ['enabled', 'mode', 'step', 'offset', 'alwaysAdvance']);
});

test('describePriceRounding', () => {
    assert.equal(describePriceRounding(null), 'off');
    assert.equal(describePriceRounding(rule({ mode: 'up', step: 10, offset: 9 })), 'rounds up to …9');
    assert.equal(describePriceRounding(rule({ mode: 'up', step: 1, offset: 0.99 })), 'rounds up to ….99');
    assert.equal(describePriceRounding(rule({ mode: 'up', step: 1, offset: 0 })), 'rounds up to whole');
    assert.equal(describePriceRounding(rule({ mode: 'down', step: 5, offset: 0, alwaysAdvance: true })), 'rounds down to 5, always');
    assert.equal(describePriceRounding(rule({ mode: 'nearest', step: 0.05, offset: 0 })), 'rounds to nearest 0.05');
});
