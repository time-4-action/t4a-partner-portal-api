/**
 * Sources API AI autofill smoke test (docs/sources-api-ai.md).
 *
 * Boots the Express app in-process against a throwaway MongoDB, seeds one connected store with a
 * key, one product the portal created (a feed row plus its `shopify_product_map` row), and stands
 * a fake in for the model. Walks both endpoints the way Recharge Hub calls them: the key and shop
 * binding, request checks, the supplier facts reaching the prompt, and every answer the caller
 * must never receive (a category it did not send, an option code it did not offer, a variant the
 * product does not have, a duplicate).
 *
 *   MONGO_URI=mongodb://localhost:27099 MONGO_DB_NAME=sources_ai_smoke node scripts/sources-api-ai-smoke.js
 *
 * Exits non-zero on the first failed expectation.
 */
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27099';
process.env.MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'sources_ai_smoke';
process.env.SHOPIFY_TOKEN_ENC_KEY = process.env.SHOPIFY_TOKEN_ENC_KEY || 'a'.repeat(64);
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';
process.env.PRODUCTS_DOWNLOAD_SCHEDULE = process.env.PRODUCTS_DOWNLOAD_SCHEDULE || '';
process.env.PARTNER_ADMIN_TOKEN = process.env.PARTNER_ADMIN_TOKEN || 'x';
process.env.WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY || 'x';
process.env.AUTH0_ISSUER_BASE_URL = process.env.AUTH0_ISSUER_BASE_URL || 'https://example.auth0.com/';
process.env.AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'https://example.test/api';
process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || 'x';
process.env.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || 'x';
process.env.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || 'https://example.test';

const assert = require('node:assert/strict');

const { app } = require('../src/app');
const { connectToDb, getDb } = require('../src/services/db/mongo.service');
const connectionService = require('../src/services/shopify/shopifyConnection.service');
const { encryptToken } = require('../src/services/shopify/crypto.service');
const { createConnectionApiKey } = require('../src/services/shopify/connectionApiKey.service');
const productAutofill = require('../src/services/ai/productAutofill.service');

const SHOP = 'recharge-ai-smoke.myshopify.com';
const PRODUCT_GID = 'gid://shopify/Product/42';

// ── The model: answers what the test says next, and remembers what it was asked ──
const asked = [];
let nextAnswer = {};
let nextStop = 'end_turn';
productAutofill.setClientForTests({
    messages: {
        create: async (request) => {
            asked.push(request);
            return {
                stop_reason: nextStop,
                usage: { input_tokens: 100, output_tokens: 20 },
                content: [{ type: 'text', text: JSON.stringify(nextAnswer) }]
            };
        }
    }
});

async function seed() {
    const db = getDb();
    await db.dropDatabase();
    await connectionService.ensureIndexes();
    const conn = await db.collection('shopify_connections').insertOne({
        ownerSub: 'auth0|smoke', ownerEmail: 'smoke@example.test', shopDomain: SHOP, shopName: 'Recharge AI smoke',
        accessTokenEnc: encryptToken('shpat_test'), authMethod: 'custom_app', scopes: ['read_products', 'write_products'],
        status: 'active', shopifyLocationId: 'gid://shopify/Location/1',
        config: { ...connectionService.DEFAULT_CONFIG, scopes: [{ id: 'sc_feed', type: 'own_source', feedId: 'point7', locationId: 'gid://shopify/Location/1', ownership: 'create_then_handoff' }] },
        installedAt: new Date(), updatedAt: new Date()
    });
    await db.collection('external_products').insertOne({
        feedId: 'point7', code: 'P7-AC', product_name: 'Point-7 AC-X 5.3',
        categories: ['Windsurf sails'], tags: ['wave', '2026'], detailed_description: '<p>Wave sail, <b>5.3 m²</b>, 4 battens.</p>',
        ai_categories: [{ exportId: 'x', categoryId: 'c1', categoryName: 'Windsurf / Sails' }]
    });
    // A row from another feed with the same code must not lend its facts.
    await db.collection('external_products').insertOne({ feedId: 'other', code: 'P7-AC', product_name: 'Someone else', categories: ['Kites'] });
    await db.collection('shopify_product_map').insertOne({
        connectionId: conn.insertedId, shopDomain: SHOP, parentCode: 'P7-AC', variantCode: 'P7-AC-53', sku: 'P7-AC-53',
        shopifyProductId: PRODUCT_GID, shopifyVariantId: 'gid://shopify/ProductVariant/1'
    });
    const { rawKey } = await createConnectionApiKey(conn.insertedId.toString(), 'Recharge Hub', 'auth0|smoke');
    return { rawKey };
}

const PRODUCT = {
    code: PRODUCT_GID, shopifyProductId: PRODUCT_GID, name: 'AC-X 5.3', vendor: 'Point-7', productType: 'Sails',
    tags: ['awaiting-review'], description: 'Wave sail.',
    variants: [{ id: 'gid://shopify/ProductVariant/1', title: '5.3', options: [{ name: 'Size', value: '5.3' }] }]
};
const CATEGORIES = [
    { id: 'wave', label: 'All products > Windsurf > Sails > Wave sails' },
    { id: 'wetsuits', label: 'All products > Clothing > Wetsuits' }
];
const ATTRIBUTES = [
    { id: 'size', name: 'Sail size', format: 'measurement', unit: 'm²', level: 'variant' },
    { id: 'battens', name: 'Battens', format: 'integer', level: 'product' },
    { id: 'colour', name: 'Colour', format: 'choice', level: 'product', options: [{ code: 'red', label: 'Red' }, { code: 'blue', label: 'Blue' }] },
    { id: 'use', name: 'Use', format: 'choices', level: 'product', options: [{ code: 'wave', label: 'Wave' }, { code: 'freeride', label: 'Freeride' }] }
];

async function main() {
    await connectToDb();
    const { rawKey } = await seed();
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (path, body, { key = rawKey, shop = SHOP } = {}) => {
        const res = await fetch(base + path, {
            method: 'POST',
            headers: {
                accept: 'application/json', 'content-type': 'application/json',
                ...(key ? { authorization: `Bearer ${key}` } : {}),
                ...(shop ? { 'x-shop-domain': shop } : {})
            },
            body: JSON.stringify(body)
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    let failures = 0;
    const check = (name, fn) => { try { fn(); console.log('  ok  ', name); } catch (e) { failures += 1; console.log('  FAIL', name, '\n       ', e.message); } };

    try {
        console.log('auth');
        let r = await call('/ai/categorize', { products: [PRODUCT], categories: CATEGORIES }, { key: null });
        check('no key → 401', () => assert.equal(r.status, 401));
        r = await call('/ai/categorize', { products: [PRODUCT], categories: CATEGORIES }, { shop: 'other.myshopify.com' });
        check('wrong shop → 403', () => assert.equal(r.status, 403));
        check('the model was not asked', () => assert.equal(asked.length, 0));

        console.log('categorize');
        r = await call('/ai/categorize', { products: [], categories: CATEGORIES });
        check('no products → 422 on products', () => { assert.equal(r.status, 422); assert.equal(r.body.errors[0].field, 'products'); });
        r = await call('/ai/categorize', { products: [{ code: 'x' }], categories: CATEGORIES });
        check('a product without a name → 422', () => assert.equal(r.status, 422));

        nextAnswer = { results: [
            { code: PRODUCT_GID, categoryId: 'wave', confidence: 0.93, reason: 'A wave sail by name and supplier category.' },
            { code: PRODUCT_GID, categoryId: 'wetsuits', confidence: 0.5, reason: 'duplicate' },
            { code: 'B', categoryId: 'invented', confidence: 0.99, reason: 'not offered' }
        ] };
        r = await call('/ai/categorize', { products: [PRODUCT, { code: 'B', name: 'Mystery', variants: [] }, { code: 'C', name: 'Unanswered' }], categories: CATEGORIES });
        check('one result per product, in order', () => {
            assert.equal(r.status, 200);
            assert.deepEqual(r.body.results.map((x) => x.code), [PRODUCT_GID, 'B', 'C']);
        });
        check('the first answer stands, with confidence and reason', () => assert.deepEqual(r.body.results[0], {
            code: PRODUCT_GID, categoryId: 'wave', confidence: 0.93, reason: 'A wave sail by name and supplier category.'
        }));
        check('a category not sent is no category', () => { assert.equal(r.body.results[1].categoryId, null); assert.equal(r.body.results[1].confidence, null); });
        check('a product the model skipped comes back empty', () => assert.equal(r.body.results[2].categoryId, null));
        const prompt = asked.at(-1);
        check('the caller\'s categories are the list offered', () => assert.match(prompt.system[0].text, /Wave sails/));
        check('the supplier facts of this store\'s feed reach the prompt, not another feed\'s', () => {
            assert.match(prompt.messages[0].content, /Windsurf sails/);
            assert.match(prompt.messages[0].content, /4 battens/);
            assert.doesNotMatch(prompt.messages[0].content, /Kites/);
        });
        check('the Shopify id is not sent to the model', () => assert.doesNotMatch(prompt.messages[0].content, /shopifyProductId/));
        // Usage is logged fire-and-forget, as the categorizer does; give it a moment to land.
        let usage = [];
        for (let i = 0; i < 20 && usage.length === 0; i++) {
            usage = await getDb().collection('aiAnalytics').find({}).toArray();
            if (usage.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        check('usage is logged against the connection', () => assert.ok(usage.some((u) => /^sources-api:/.test(u.exportId))));

        console.log('extract attributes');
        r = await call('/ai/extract-attributes', { product: PRODUCT, attributes: [{ id: 'colour', name: 'Colour', format: 'choice', level: 'product' }] });
        check('a choice without options → 422', () => assert.equal(r.status, 422));
        r = await call('/ai/extract-attributes', { product: PRODUCT, attributes: [{ id: 'x', name: 'X', format: 'json', level: 'product' }] });
        check('an unknown format → 422', () => assert.equal(r.status, 422));

        nextAnswer = { values: [
            { attributeId: 'size', variantId: 'gid://shopify/ProductVariant/1', value: '5.3', choices: [] },
            { attributeId: 'size', variantId: 'gid://shopify/ProductVariant/999', value: '6.0', choices: [] },
            { attributeId: 'battens', variantId: '', value: '4', choices: [] },
            { attributeId: 'battens', variantId: '', value: '5', choices: [] },
            { attributeId: 'colour', variantId: '', value: 'green', choices: [] },
            { attributeId: 'use', variantId: '', value: '', choices: ['wave', 'kite'] },
            { attributeId: 'unknown', variantId: '', value: 'x', choices: [] }
        ] };
        r = await call('/ai/extract-attributes', { product: PRODUCT, attributes: ATTRIBUTES });
        check('only values the caller can use, once each', () => {
            assert.equal(r.status, 200);
            assert.deepEqual(r.body.values, [
                { attributeId: 'size', variantId: 'gid://shopify/ProductVariant/1', value: '5.3' },
                { attributeId: 'battens', variantId: null, value: '4' },
                { attributeId: 'use', variantId: null, value: ['wave'] }
            ]);
        });

        nextStop = 'refusal';
        r = await call('/ai/extract-attributes', { product: PRODUCT, attributes: ATTRIBUTES });
        check('a refusal → 502 ai_failed', () => { assert.equal(r.status, 502); assert.equal(r.body.error.code, 'ai_failed'); });
        nextStop = 'end_turn';
    } finally {
        server.close();
    }
    console.log(failures === 0 ? '\nall good' : `\n${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
