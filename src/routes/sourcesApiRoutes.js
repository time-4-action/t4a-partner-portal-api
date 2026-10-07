const express = require('express');
const router = express.Router();

const sourcesApiAuth = require('../middleware/sourcesApiAuth');
const c = require('../controllers/sourcesApiController');

/**
 * The Sources API, version 1 (`docs/sources-api.md`). Mounted at `/api/v1`, outside the
 * `/api/export` tree: it is not a partner-facing portal route but a machine contract another
 * product (Recharge Hub) implements against, keyed by a per-connection API key rather than a
 * portal login. Every route is bearer-gated; there is no public endpoint here.
 */
router.use(sourcesApiAuth);

router.get('/connection', c.connection);
router.get('/source-types', c.sourceTypes);
router.get('/sources', c.listSources);
router.post('/sources', c.createSource);
router.get('/sources/:id', c.getSource);
router.patch('/sources/:id', c.updateSource);
router.delete('/sources/:id', c.deleteSource);
router.post('/sources/:id/runs', c.startRun);
router.get('/sources/:id/runs', c.listRuns);
router.get('/runs/:runId', c.getRun);

// AI autofill (docs/sources-api-ai.md): the categorizer and the attribute reader, against the
// caller's own categories and attributes. Nothing is stored and nothing is written to the store.
router.post('/ai/categorize', c.categorize);
router.post('/ai/extract-attributes', c.extractAttributes);

// Anything else under /api/v1 is a contract miss, answered in the contract's shape.
router.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: `No such endpoint: ${req.method} ${req.path}` } });
});

module.exports = router;
