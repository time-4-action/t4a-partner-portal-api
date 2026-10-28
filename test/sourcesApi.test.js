const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// The service pulls in the Mongo and Anthropic modules, which refuse to load without these.
// Dummy values only: nothing here connects or calls out.
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:1';
process.env.MONGO_DB_NAME ??= 'test';
process.env.ANTHROPIC_API_KEY ??= 'test';

const connectionService = require('../src/services/shopify/shopifyConnection.service');
const syncJobs = require('../src/services/shopify/shopifySyncJobs.service');
const sourcesApi = require('../src/services/shopify/sourcesApi.service');

const saved = {};
beforeEach(() => {
    saved.url = process.env.SHOPIFY_PORTAL_RETURN_URL;
    saved.getConnectionWithToken = connectionService.getConnectionWithToken;
    saved.ensureScopeIds = connectionService.ensureScopeIds;
    saved.getRun = syncJobs.getRun;
});
afterEach(() => {
    if (saved.url === undefined) delete process.env.SHOPIFY_PORTAL_RETURN_URL;
    else process.env.SHOPIFY_PORTAL_RETURN_URL = saved.url;
    connectionService.getConnectionWithToken = saved.getConnectionWithToken;
    connectionService.ensureScopeIds = saved.ensureScopeIds;
    syncJobs.getRun = saved.getRun;
});

// ─── portalUrl: absolute or absent, never "/" ───────────────────────────────

test('portalUrl is omitted when SHOPIFY_PORTAL_RETURN_URL is unset', () => {
    delete process.env.SHOPIFY_PORTAL_RETURN_URL;
    assert.equal(sourcesApi.portalUrl(), undefined);
});

test('portalUrl is omitted for the relative default "/" and other non-URLs', () => {
    for (const value of ['/', '/shopify', 'portal.example/shopify', 'javascript:alert(1)', '']) {
        process.env.SHOPIFY_PORTAL_RETURN_URL = value;
        assert.equal(sourcesApi.portalUrl(), undefined, `value ${JSON.stringify(value)}`);
    }
});

test('portalUrl is an absolute https URL when the return URL is one', () => {
    process.env.SHOPIFY_PORTAL_RETURN_URL = 'https://portal.example/shopify';
    assert.match(sourcesApi.portalUrl(), /^https:\/\//);
    assert.equal(sourcesApi.portalUrl(), 'https://portal.example/shopify');
});

// ─── getRun: a run is named after the source it was started for ─────────────

const OID = (n) => ({ toString: () => n });
function stubTenant(scopes) {
    const connection = { _id: OID('conn1'), shopDomain: 'x.myshopify.com', config: { scopes } };
    connectionService.getConnectionWithToken = async () => connection;
    connectionService.ensureScopeIds = async (c) => c;
}
const job = (extra) => ({
    _id: OID('run1'), connectionId: OID('conn1'), status: 'completed', trigger: 'api:Hub',
    createdAt: new Date('2026-10-01T10:00:00Z'), counts: { inScope: 3 }, ...extra
});

test('getRun names the stored scope even when that scope has been deleted', async () => {
    // The connection now has a different source; the run's own scope id is gone from it.
    stubTenant([{ id: 'sc_other', type: 'own_source', feedId: 'f' }]);
    syncJobs.getRun = async () => job({ scopeIds: ['sc_deleted'], scopes: [] });
    const { run } = await sourcesApi.getRun('conn1', 'run1');
    assert.equal(run.sourceId, 'sc_deleted');
});

test('getRun prefers the scope summary recorded on the job', async () => {
    stubTenant([]);
    syncJobs.getRun = async () => job({ scopeIds: ['sc_a'], scopes: [{ id: 'sc_a', products: 7 }] });
    const { run } = await sourcesApi.getRun('conn1', 'run1');
    assert.equal(run.sourceId, 'sc_a');
    assert.equal(run.itemCount, 7);
});

test('getRun answers 404 rather than sourceId "" when the job records no scope', async () => {
    stubTenant([{ id: 'sc_other', type: 'own_source', feedId: 'f' }]);
    syncJobs.getRun = async () => job({ scopeIds: [], scopes: [] });
    await assert.rejects(() => sourcesApi.getRun('conn1', 'run1'), (err) => {
        assert.equal(err.status, 404);
        return true;
    });
});

test('getRun still refuses a run of another tenant with 404', async () => {
    stubTenant([]);
    syncJobs.getRun = async () => job({ connectionId: OID('someone-else'), scopeIds: ['sc_a'] });
    await assert.rejects(() => sourcesApi.getRun('conn1', 'run1'), (err) => err.status === 404);
});
