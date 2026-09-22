/**
 * Sources API smoke test (docs/sources-api.md).
 *
 * Boots the Express app in-process against a throwaway MongoDB, seeds one connected store with
 * a catalogue export and a feed, mints a key, and walks the whole contract the way Recharge Hub
 * does: connection → source types → create → list → get → patch → run → runs → run detail →
 * delete, plus every refusal (no key, wrong key, wrong shop, bad field values, unknown source).
 * Shopify is never called: the GraphQL reads and the token are stubbed and the seeded feed has no
 * products, so the real engine runs a per-source run that writes nothing. What is tested is the
 * contract, the key binding and the scope bookkeeping.
 *
 *   MONGO_URI=mongodb://localhost:27099 MONGO_DB_NAME=sources_smoke node scripts/sources-api-smoke.js
 *
 * Exits non-zero on the first failed expectation.
 */
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27099';
process.env.MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'sources_smoke';
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

// ── Stubs: nothing reaches Shopify ──────────────────────────────────────────
const graphql = require('../src/services/shopify/shopifyGraphql.service');
graphql.listLocations = async () => [
    { id: 'gid://shopify/Location/1', name: 'Main warehouse', active: true, fulfillmentServiceId: null },
    { id: 'gid://shopify/Location/2', name: 'Brand corner', active: true, fulfillmentServiceId: null },
    { id: 'gid://shopify/Location/3', name: '3PL', active: true, fulfillmentServiceId: 'gid://shopify/FulfillmentService/9' }
];
graphql.listPublications = async () => [{ id: 'gid://shopify/Publication/10', name: 'Online Store' }];
const tokenService = require('../src/services/shopify/shopifyToken.service');
tokenService.getValidAccessToken = async () => 'shpat_test';
// The push itself is the REAL engine: the feed below has no imported products, so the run
// finds nothing in scope and finishes without a single Shopify write — which is exactly the
// path that proves a per-source run resolves its one scope and records it.

const { app } = require('../src/app');
const { connectToDb, getDb } = require('../src/services/db/mongo.service');
const connectionService = require('../src/services/shopify/shopifyConnection.service');
const { encryptToken } = require('../src/services/shopify/crypto.service');
const { createConnectionApiKey } = require('../src/services/shopify/connectionApiKey.service');

const SHOP = 'recharge-smoke.myshopify.com';

async function seed() {
    const db = getDb();
    await db.dropDatabase();
    await connectionService.ensureIndexes();
    const exportId = (await db.collection('export_configs').insertOne({
        name: 'Recharge catalogue', preset: 'shopify', isActive: true, owner: { sub: 'auth0|smoke', email: 'smoke@example.test' },
        fields: [], filters: {}, pricelistPriority: [], createdAt: new Date()
    })).insertedId.toString();
    await db.collection('exports').insertOne({ name: 'Recharge categories', aiCategorizationEnabled: true });
    await db.collection('own_sources').insertOne({
        feedId: 'point7', brand: 'Point-7', ownerSub: 'auth0|smoke', schedule: { enabled: true, frequency: 'daily', timeOfDay: '04:00', timezone: 'Europe/Ljubljana' },
        nextRunAt: new Date(Date.now() + 3600_000), aiCategorization: { enabled: false, exportIds: [] }, feed: { url: 'https://example.test/feed.json' }, createdAt: new Date()
    });
    await db.collection('products').insertOne({ code: 'X', pricelist: [{ name: 'RRP 2026', price: 10, vat: 22 }], child_products: [], published: true, active: true });
    const conn = await db.collection('shopify_connections').insertOne({
        ownerSub: 'auth0|smoke', ownerEmail: 'smoke@example.test', shopDomain: SHOP, shopName: 'Recharge smoke',
        accessTokenEnc: encryptToken('shpat_test'), authMethod: 'custom_app', scopes: ['read_products', 'write_products', 'read_inventory', 'write_inventory', 'read_locations', 'read_publications', 'write_publications'],
        status: 'active', shopifyLocationId: 'gid://shopify/Location/1',
        // A legacy scope with no id: the API must stamp one and keep it.
        config: { ...connectionService.DEFAULT_CONFIG, scopes: [{ type: 'export_config', exportConfigId: exportId, locationId: 'gid://shopify/Location/1', ownership: 'stock_only' }] },
        installedAt: new Date(), lastSyncAt: null, lastSyncStatus: null, updatedAt: new Date()
    });
    const { rawKey } = await createConnectionApiKey(conn.insertedId.toString(), 'Recharge Hub', 'auth0|smoke');
    return { rawKey, exportId, connectionId: conn.insertedId.toString() };
}

async function main() {
    await connectToDb();
    const { rawKey, exportId } = await seed();
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (method, path, { key = rawKey, shop = SHOP, body } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: {
                accept: 'application/json',
                ...(key ? { authorization: `Bearer ${key}` } : {}),
                ...(shop ? { 'x-shop-domain': shop } : {}),
                ...(body !== undefined ? { 'content-type': 'application/json' } : {})
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    let failures = 0;
    const check = (name, fn) => { try { fn(); console.log('  ok  ', name); } catch (e) { failures += 1; console.log('  FAIL', name, '\n       ', e.message); } };

    try {
        console.log('auth');
        let r = await call('GET', '/connection', { key: null }); check('no key → 401 missing_key', () => { assert.equal(r.status, 401); assert.equal(r.body.error.code, 'missing_key'); });
        r = await call('GET', '/connection', { key: 'sk_t4a_deadbeef' }); check('unknown key → 401', () => assert.equal(r.status, 401));
        r = await call('GET', '/connection', { shop: 'other.myshopify.com' }); check('wrong shop → 403 shop_mismatch', () => { assert.equal(r.status, 403); assert.equal(r.body.error.code, 'shop_mismatch'); });
        r = await call('GET', '/connection'); check('connection names the tenant, shop and key', () => {
            assert.equal(r.status, 200); assert.equal(r.body.tenant.name, 'Recharge smoke'); assert.equal(r.body.shop.domain, SHOP); assert.equal(r.body.key.name, 'Recharge Hub');
        });

        console.log('source types');
        r = await call('GET', '/source-types'); check('two kinds with fields and live locations', () => {
            assert.equal(r.status, 200); assert.equal(r.body.types.length, 2);
            const kinds = r.body.types.map((t) => t.kind).sort();
            assert.deepEqual(kinds, [`export_config:${exportId}`, 'own_source:point7']);
            const loc = r.body.types[0].fields.find((f) => f.key === 'locationId');
            assert.equal(loc.options.length, 2, '3PL location excluded');
            assert.ok(r.body.types[0].fields.some((f) => f.key === 'publication:gid://shopify/Publication/10'));
        });

        console.log('list (legacy scope stamped)');
        r = await call('GET', '/sources'); check('one existing source, with an id and never_ran', () => {
            assert.equal(r.status, 200); assert.equal(r.body.sources.length, 1);
            assert.match(r.body.sources[0].id, /^sc_/); assert.equal(r.body.sources[0].health, 'never_ran');
            assert.equal(r.body.sources[0].name, 'Recharge catalogue → Main warehouse');
        });
        const legacyId = r.body.sources[0].id;
        r = await call('GET', '/sources'); check('the stamped id is stable across reads', () => assert.equal(r.body.sources[0].id, legacyId));

        console.log('create');
        r = await call('POST', '/sources', { body: { kind: 'own_source:point7', name: '', values: {} } });
        check('empty name → 422 with field error', () => { assert.equal(r.status, 422); assert.equal(r.body.errors[0].field, 'name'); });
        r = await call('POST', '/sources', { body: { kind: 'own_source:point7', name: 'Point-7 corner', values: { ownership: 'create_then_handoff', priceFactor: 'abc' } } });
        check('no location + bad factor → 422 naming both', () => {
            assert.equal(r.status, 422);
            const fields = r.body.errors.map((e) => e.field).sort();
            assert.deepEqual(fields, ['locationId', 'priceFactor']);
        });
        r = await call('POST', '/sources', { body: { kind: 'own_source:point7', name: 'Point-7 corner', values: {
            locationId: 'gid://shopify/Location/2', ownership: 'create_then_handoff', syncNewProducts: true, priceFactor: 1.2,
            rounding_enabled: true, rounding_step: 10, rounding_offset: 9, 'publication:gid://shopify/Publication/10': true, pricelistPriority: 'RRP 2026, RRP 2025'
        } } });
        check('created with values applied', () => {
            assert.equal(r.status, 201); const s = r.body.source;
            assert.equal(s.name, 'Point-7 corner'); assert.equal(s.kindLabel, 'Point-7'); assert.equal(s.enabled, true);
            assert.equal(s.values.locationId, 'gid://shopify/Location/2'); assert.equal(s.values.ownership, 'create_then_handoff');
            assert.equal(s.values.priceFactor, 1.2); assert.equal(s.values.rounding_enabled, true); assert.equal(s.values.rounding_offset, 9);
            assert.equal(s.values['publication:gid://shopify/Publication/10'], true);
            assert.equal(s.values.pricelistPriority, 'RRP 2026, RRP 2025');
            assert.equal(s.schedule.mode, 'automatic'); assert.match(s.schedule.description, /Every day at 04:00/);
            assert.equal(s.destination, 'Recharge smoke · Brand corner');
        });
        const feedSourceId = r.body.source.id;

        console.log('update');
        r = await call('PATCH', `/sources/${feedSourceId}`, { body: { values: { ownership: 'nonsense' } } });
        check('bad choice → 422 against the field', () => { assert.equal(r.status, 422); assert.equal(r.body.errors[0].field, 'ownership'); });
        r = await call('PATCH', `/sources/${feedSourceId}`, { body: { name: 'Point-7 (brand corner)', enabled: false, values: { syncPrices: true, 'publication:gid://shopify/Publication/10': false } } });
        check('partial write keeps the rest', () => {
            assert.equal(r.status, 200); const s = r.body.source;
            assert.equal(s.name, 'Point-7 (brand corner)'); assert.equal(s.enabled, false); assert.equal(s.health, 'off');
            assert.equal(s.values.syncPrices, true); assert.equal(s.values.ownership, 'create_then_handoff');
            assert.equal(s.values['publication:gid://shopify/Publication/10'], false); assert.equal(s.values.priceFactor, 1.2);
        });
        r = await call('POST', `/sources/${feedSourceId}/runs`, { body: {} });
        check('running a switched-off source → 409', () => { assert.equal(r.status, 409); assert.equal(r.body.error.code, 'source_off'); });
        r = await call('PATCH', `/sources/${feedSourceId}`, { body: { enabled: true } }); check('turned back on', () => assert.equal(r.body.source.enabled, true));

        console.log('the portal UI re-saving without ids keeps identity');
        const raw = await connectionService.getConnectionWithToken((await getDb().collection('shopify_connections').findOne({ shopDomain: SHOP }))._id);
        const uiScopes = raw.config.scopes.map(({ id: _i, name: _n, enabled: _e, ...rest }) => rest);
        await connectionService.updateConnectionConfig(raw._id.toString(), { config: { scopes: uiScopes } });
        r = await call('GET', '/sources'); check('ids and names survive a whitelist save', () => {
            const ids = r.body.sources.map((s) => s.id).sort(); assert.deepEqual(ids, [legacyId, feedSourceId].sort());
            assert.equal(r.body.sources.find((s) => s.id === feedSourceId).name, 'Point-7 (brand corner)');
        });

        console.log('runs');
        r = await call('POST', `/sources/${feedSourceId}/runs`, { body: {} });
        check('run accepted (202) for the one source', () => { assert.equal(r.status, 202); assert.equal(r.body.run.sourceId, feedSourceId); assert.ok(['queued', 'running', 'completed'].includes(r.body.run.status)); });
        const runId = r.body.run.id;
        await new Promise((resolve) => setTimeout(resolve, 300));
        r = await call('GET', `/sources/${feedSourceId}/runs?limit=5`); check('the run is listed for its source, completed', () => {
            assert.equal(r.status, 200); assert.equal(r.body.runs.length, 1); assert.equal(r.body.runs[0].status, 'completed');
            assert.equal(r.body.runs[0].itemCount, 0); assert.equal(r.body.runs[0].message, 'Nothing in scope'); assert.match(r.body.runs[0].triggeredBy, /^api:/);
        });
        r = await call('GET', `/sources/${legacyId}/runs`); check('and not for the other source', () => assert.equal(r.body.runs.length, 0));
        r = await call('GET', `/runs/${runId}`); check('run detail carries a log', () => {
            assert.equal(r.status, 200); assert.equal(r.body.run.id, runId); assert.ok(r.body.log.length >= 2); assert.equal(r.body.log[0].level, 'info');
        });
        r = await call('GET', '/sources'); check('health is ok after a clean run', () => assert.equal(r.body.sources.find((s) => s.id === feedSourceId).health, 'ok'));
        r = await call('GET', '/runs/000000000000000000000000'); check('unknown run → 404', () => assert.equal(r.status, 404));

        console.log('delete');
        r = await call('DELETE', `/sources/${feedSourceId}`); check('delete → 204', () => assert.equal(r.status, 204));
        r = await call('GET', `/sources/${feedSourceId}`); check('gone → 404', () => assert.equal(r.status, 404));
        r = await call('GET', '/sources'); check('the other source remains', () => { assert.equal(r.body.sources.length, 1); assert.equal(r.body.sources[0].id, legacyId); });
        r = await call('GET', '/nope'); check('unknown endpoint → 404 in contract shape', () => { assert.equal(r.status, 404); assert.ok(r.body.error.code); });
    } finally {
        server.close();
    }
    console.log(failures === 0 ? '\nall good' : `\n${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
