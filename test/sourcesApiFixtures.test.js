const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The recorded replies Recharge Hub parses in its own tests. Missing or unreadable files mean the
// recording was not refreshed (docs/fixtures/sources-api/README.md).
const DIR = path.join(__dirname, '..', 'docs', 'fixtures', 'sources-api');
const NAMES = [
    'connection', 'source-types', 'sources', 'source', 'runs', 'run-started', 'run-detail', 'run-detail-failed',
    'ai-categorize', 'ai-extract-attributes',
    'error-401', 'error-403', 'error-404', 'error-409', 'error-422', 'error-502', 'error-503'
];
const read = (name) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));

test('every contract fixture exists and is JSON', () => {
    for (const name of NAMES) assert.doesNotThrow(() => read(name), name);
});

test('the sources fixture covers every health value', () => {
    assert.deepEqual([...new Set(read('sources').sources.map((s) => s.health))].sort(), ['needs_attention', 'never_ran', 'off', 'ok']);
});

test('the runs fixture covers running, completed and failed, all with a sourceId', () => {
    const runs = read('runs').runs;
    assert.deepEqual(runs.map((r) => r.status).sort(), ['completed', 'failed', 'running']);
    for (const r of runs) assert.ok(r.sourceId.length > 0);
});

test('the source fixture carries tokens and no secrets', () => {
    const raw = fs.readFileSync(path.join(DIR, 'source.json'), 'utf8');
    assert.ok(read('source').source.fields.find((f) => f.key === 'titlePrefix').tokens.length > 0);
    assert.doesNotMatch(raw, /shpat_|sk_t4a_(?!REDACTED)/);
});
