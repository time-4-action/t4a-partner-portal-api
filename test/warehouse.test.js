const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    rowFreeAmount, accumulateStockRows, getProductStockAmount
} = require('../src/services/metakocka/warehouse.service');

// Stored stock is the FREE amount (available to sell), never raw `amount` — see CLAUDE.md.

test('rowFreeAmount uses free_amount when Metakocka sends it', () => {
    assert.equal(rowFreeAmount({ amount: '10', reserved_amount: '4', free_amount: '6' }), 6);
    // free_amount wins even when it disagrees with amount - reserved
    assert.equal(rowFreeAmount({ amount: '10', reserved_amount: '0', free_amount: '3' }), 3);
});

test('rowFreeAmount treats a free_amount of "0" as zero, not as missing', () => {
    assert.equal(rowFreeAmount({ amount: '5', reserved_amount: '5', free_amount: '0' }), 0);
    assert.equal(rowFreeAmount({ amount: '5', free_amount: 0 }), 0);
});

test('rowFreeAmount falls back to amount - reserved_amount without free_amount', () => {
    assert.equal(rowFreeAmount({ amount: '10', reserved_amount: '4' }), 6);
    assert.equal(rowFreeAmount({ amount: '10', reserved_amount: '4', free_amount: '' }), 6);
    assert.equal(rowFreeAmount({ amount: '10', reserved_amount: '4', free_amount: null }), 6);
});

test('rowFreeAmount reduces to amount when there are no reservations', () => {
    assert.equal(rowFreeAmount({ amount: '7' }), 7);
    assert.equal(rowFreeAmount({}), 0);
});

test('accumulateStockRows sums free/amount/reserved per code across microlocations', () => {
    const map = accumulateStockRows(new Map(), [
        { code: 'A', amount: '5', reserved_amount: '1', free_amount: '4', count_code: 'cc', mk_id: '1' },
        { code: 'A', amount: '3', reserved_amount: '0', free_amount: '3', count_code: 'cc', mk_id: '1' },
        { code: 'B', amount: '2' }
    ]);
    assert.deepEqual(map.get('A'), { code: 'A', free: 7, amount: 8, reserved: 1, count_code: 'cc', mk_id: '1' });
    assert.equal(map.get('B').free, 2);
    assert.equal(map.size, 2);
});

test('accumulateStockRows mixes rows with and without free_amount', () => {
    const map = accumulateStockRows(new Map(), [
        { code: 'A', amount: '5', reserved_amount: '2', free_amount: '3' },
        { code: 'A', amount: '4', reserved_amount: '1' }
    ]);
    assert.equal(map.get('A').free, 6);
});

test('accumulateStockRows skips code-less rows and keeps summing across pages', () => {
    const map = new Map();
    accumulateStockRows(map, [{ amount: '9' }, { code: '', amount: '9' }, { code: 'A', amount: '1' }]);
    accumulateStockRows(map, [{ code: 'A', amount: '2' }]);
    assert.equal(map.size, 1);
    assert.equal(map.get('A').free, 3);
});

test('getProductStockAmount returns the free amount, never raw amount', () => {
    const map = accumulateStockRows(new Map(), [{ code: 'A', amount: '10', reserved_amount: '6', free_amount: '4' }]);
    assert.equal(getProductStockAmount(map, 'A'), 4);
    assert.equal(getProductStockAmount(map, 'missing'), 0);
});
