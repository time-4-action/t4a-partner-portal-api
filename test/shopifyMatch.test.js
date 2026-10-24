const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// shopifyMatch destructures `graphqlRequest` at load, so the stub goes in before it is required.
// No request ever leaves the process.
const graphql = require('../src/services/shopify/shopifyGraphql.service');
let calls = [];
let respond = () => ({ productVariants: { edges: [], pageInfo: { hasNextPage: false } } });
graphql.graphqlRequest = async (shop, token, query, variables) => {
    calls.push(variables);
    return respond(variables);
};
const { matchVariants, _internals: { escapeTerm } } = require('../src/services/shopify/shopifyMatch.service');

const node = (id, sku, barcode = null) => ({ id, sku, barcode, inventoryItem: { id: `ii-${id}` }, product: { id: `p-${id}` } });
const page = (nodes, next = null) => ({
    productVariants: { edges: nodes.map((n) => ({ node: n })), pageInfo: { hasNextPage: !!next, endCursor: next } }
});

beforeEach(() => { calls = []; });

test('escapeTerm escapes quotes and backslashes for a search term', () => {
    assert.equal(escapeTerm("O'Neill"), "O\\'Neill");
    assert.equal(escapeTerm('a\\b'), 'a\\\\b');
});

test('matches a unique SKU, flags duplicates, falls back to barcode', async () => {
    respond = ({ query }) => {
        if (query.startsWith('sku:')) {
            // Shopify search is loose: 'A1' also hits 'A10' — only exact equality may count.
            return page([node('1', 'A1'), node('10', 'A10'), node('2', 'DUP'), node('3', 'DUP')]);
        }
        return page([node('4', 'other-sku', '3830001')]);
    };
    const r = await matchVariants('s.myshopify.com', 'tok', [
        { sku: 'A1' }, { sku: 'DUP' }, { sku: 'NOPE', barcode: '3830001' }, { sku: 'GONE' }
    ]);
    assert.equal(r.get('A1').node.id, '1');
    assert.equal(r.get('A1').matchedOn, 'sku');
    assert.equal(r.get('DUP').node, null);
    assert.match(r.get('DUP').reason, /Duplicate SKU/);
    assert.equal(r.get('NOPE').node.id, '4');
    assert.equal(r.get('NOPE').matchedOn, 'barcode');
    assert.equal(r.get('GONE').reason, 'No SKU / barcode match in store');
    assert.equal(calls.length, 2);
});

test('paginates a batch until hasNextPage is false', async () => {
    respond = ({ cursor }) => (cursor ? page([node('2', 'B')]) : page([node('1', 'A')], 'c1'));
    const r = await matchVariants('s', 't', [{ sku: 'A' }, { sku: 'B' }]);
    assert.equal(r.get('A').node.id, '1');
    assert.equal(r.get('B').node.id, '2');
    assert.deepEqual(calls.map((c) => c.cursor), [null, 'c1']);
});

test('batches SKUs 30 to a query and skips the call with nothing to match', async () => {
    respond = () => page([]);
    await matchVariants('s', 't', Array.from({ length: 61 }, (_, i) => ({ sku: `S${i}` })));
    assert.equal(calls.length, 3);
    assert.equal(calls[0].query.split(' OR ').length, 30);
    calls = [];
    assert.equal((await matchVariants('s', 't', [{ sku: '' }])).size, 0);
    assert.equal(calls.length, 0);
});
