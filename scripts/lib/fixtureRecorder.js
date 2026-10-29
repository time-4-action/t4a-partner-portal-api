/**
 * Records the replies a smoke script sees as contract fixtures (docs/fixtures/sources-api/).
 *
 *   node scripts/sources-api-smoke.js --record
 *   node scripts/sources-api-ai-smoke.js --record
 *
 * A fixture is the reply BODY exactly as the wire carried it, after anonymising: connection and
 * run ids, source ids, timestamps and key material are replaced by stable placeholders, in order
 * of appearance. Nothing else is touched, so the shape is the real one. The status lives in the
 * file name for refusals (`error-422.json`). Recordings are not run in CI; recorded files are
 * what Recharge Hub copies to tests/fixtures/export-portal/.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'docs', 'fixtures', 'sources-api');
const enabled = process.argv.includes('--record');

const seen = new Map();
function stable(kind, value, make) {
    const key = `${kind}:${value}`;
    if (!seen.has(key)) seen.set(key, make([...seen.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1));
    return seen.get(key);
}

/** Replaces ids, timestamps and key-like strings with stable placeholders. */
function anonymise(body) {
    return JSON.parse(JSON.stringify(body)
        .replace(/sk_t4a_[A-Za-z0-9]+/g, 'sk_t4a_REDACTED')
        .replace(/\bsc_[A-Za-z0-9]+/g, (v) => stable('sc', v, (n) => `sc_fixture${n}`))
        .replace(/\b[0-9a-f]{24}\b/g, (v) => stable('oid', v, (n) => n.toString(16).padStart(24, '0')))
        .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, (v) => stable('ts', v, (n) => new Date(Date.UTC(2026, 0, 1, 9, n)).toISOString())));
}

const recorded = new Map();
/** Keeps the latest reply for a name; no-op unless --record was passed. */
function save(name, body) {
    if (enabled && body !== null && body !== undefined) recorded.set(name, anonymise(body));
}

function flush() {
    if (!enabled) return;
    fs.mkdirSync(DIR, { recursive: true });
    for (const [name, body] of recorded) fs.writeFileSync(path.join(DIR, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
    console.log(`recorded ${recorded.size} fixture(s) in ${path.relative(process.cwd(), DIR)}`);
}

module.exports = { enabled, save, flush, anonymise, DIR };
