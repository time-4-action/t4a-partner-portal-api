const express = require('express');
const fs = require('fs');
const router = express.Router();
const { SCHEMA_PATH } = require('../services/external/feedValidator.service');

/**
 * Published feed contracts — public, no auth, no DB.
 *
 * Serves the Own Source JSON Schema VERBATIM: the very file `feedValidator.service.js` compiles,
 * so what a supplier (or recharge-partners-integration-api, which vendors a copy and diffs it
 * against this) reads is exactly what an import is validated against. Read once at startup;
 * Express adds an ETag, so a client polling for changes gets a cheap 304.
 */
const OWN_SOURCE_V1 = fs.readFileSync(SCHEMA_PATH);

function getOwnSourceV1(_req, res) {
    res.set('Cache-Control', 'public, max-age=3600')
        .type('application/schema+json')
        .send(OWN_SOURCE_V1);
}

router.get('/own-source.v1.json', getOwnSourceV1);

module.exports = router;
module.exports.getOwnSourceV1 = getOwnSourceV1;
