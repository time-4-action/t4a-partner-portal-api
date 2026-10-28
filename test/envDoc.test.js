const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// docs/env.md must name every variable the code reads, so a new one cannot ship undocumented.
const root = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs', 'env.md'), 'utf8');

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

function namesRead() {
    const files = [...sourceFiles(path.join(root, 'src')), path.join(root, 'index.js')].filter((f) => fs.existsSync(f));
    const names = new Set();
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
        for (const m of text.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) names.add(m[1]);
    }
    return [...names].sort();
}

test('docs/env.md documents every process.env name read in src/', () => {
    const names = namesRead();
    assert.ok(names.length > 20, `expected to find the env reads, found ${names.length}`);
    const missing = names.filter((n) => !doc.includes(`\`${n}\``));
    assert.deepEqual(missing, [], `add these to docs/env.md: ${missing.join(', ')}`);
});

test('docs/env.md lists the Shopify variables the contract depends on', () => {
    for (const n of [
        'SHOPIFY_PORTAL_RETURN_URL', 'SHOPIFY_PORTAL_WELCOME_URL', 'SHOPIFY_PORTAL_PRERELEASE_RETURN_URL',
        'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SHOPIFY_SCOPES', 'SHOPIFY_STATE_SECRET',
        'SHOPIFY_TOKEN_ENC_KEY', 'SHOPIFY_API_BASE_URL', 'SHOPIFY_API_VERSION', 'APP_NAME'
    ]) {
        assert.ok(doc.includes(`\`${n}\``), `${n} missing from docs/env.md`);
    }
});
