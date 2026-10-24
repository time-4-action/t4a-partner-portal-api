const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const express = require('express');
const schemaRoutes = require('../src/routes/schemaRoutes');
const { SCHEMA_PATH } = require('../src/services/external/feedValidator.service');

// The router mounted on a bare app at the same prefix as src/app.js — no DB, no analytics.
let server;
let base;
before(async () => {
    const app = express();
    app.use('/api/export/schemas', schemaRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/export/schemas`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('serves the Own Source schema verbatim, typed and cacheable', async () => {
    const res = await fetch(`${base}/own-source.v1.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/schema\+json/);
    assert.match(res.headers.get('cache-control'), /public/);
    assert.ok(res.headers.get('etag'));
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(fs.readFileSync(SCHEMA_PATH)), 'body must be the schema file byte for byte');
    assert.equal(JSON.parse(body.toString('utf8')).$id, 'https://time-4-action.com/schemas/own-source.v1.json');
});

// Plain node:http here: fetch turns a conditional request into `Cache-Control: no-cache`, which
// (correctly) makes the server ignore If-None-Match.
test('answers a conditional request with 304', async () => {
    const etag = (await fetch(`${base}/own-source.v1.json`)).headers.get('etag');
    const status = await new Promise((resolve, reject) => {
        http.get(`${base}/own-source.v1.json`, { headers: { 'If-None-Match': etag } }, (res) => {
            res.resume();
            resolve(res.statusCode);
        }).on('error', reject);
    });
    assert.equal(status, 304);
});

test('does not serve anything else', async () => {
    assert.equal((await fetch(`${base}/own-source.v2.json`)).status, 404);
    assert.equal((await fetch(`${base}/../feedValidator.service.js`)).status, 404);
});
