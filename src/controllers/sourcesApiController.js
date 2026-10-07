const sourcesApi = require('../services/shopify/sourcesApi.service');
const { SourcesApiError } = sourcesApi;

/**
 * The Sources API (`/api/v1`, `docs/sources-api.md`) — the contract Recharge Hub's Sources area
 * calls. Every handler works on the ONE connection the bearer key resolved to
 * (`req.sourcesApi.connection`); a source or run id from another connection is a 404, never a
 * leak. Replies are the contract's envelopes; refusals are `{ error: { code, message }, errors? }`.
 */

function handleError(res, error) {
    if (error instanceof SourcesApiError) {
        const body = { error: { code: error.code, message: error.message } };
        if (error.fieldErrors?.length) body.errors = error.fieldErrors;
        return res.status(error.status).json(body);
    }
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_ID' ? 400 : 500;
    if (status === 500) console.error('[sources-api] error:', error);
    return res.status(status).json({ error: { code: error.code || 'server_error', message: status === 500 ? 'The export portal hit an error.' : error.message } });
}

const tenant = (req) => req.sourcesApi.connection;

exports.connection = async (req, res) => {
    try {
        res.json(await sourcesApi.connectionInfo(tenant(req), req.sourcesApi.keyRecord));
    } catch (error) {
        handleError(res, error);
    }
};

exports.sourceTypes = async (req, res) => {
    try {
        res.json({ types: await sourcesApi.listSourceTypes(tenant(req)) });
    } catch (error) {
        handleError(res, error);
    }
};

exports.listSources = async (req, res) => {
    try {
        res.json({ sources: await sourcesApi.listSources(tenant(req)._id) });
    } catch (error) {
        handleError(res, error);
    }
};

exports.createSource = async (req, res) => {
    try {
        const body = req.body || {};
        const source = await sourcesApi.createSource(tenant(req)._id, { kind: body.kind, name: body.name, values: body.values });
        res.status(201).json({ source });
    } catch (error) {
        handleError(res, error);
    }
};

exports.getSource = async (req, res) => {
    try {
        res.json({ source: await sourcesApi.getSource(tenant(req)._id, req.params.id) });
    } catch (error) {
        handleError(res, error);
    }
};

exports.updateSource = async (req, res) => {
    try {
        const body = req.body || {};
        const source = await sourcesApi.updateSource(tenant(req)._id, req.params.id, { name: body.name, enabled: body.enabled, values: body.values });
        res.json({ source });
    } catch (error) {
        handleError(res, error);
    }
};

exports.deleteSource = async (req, res) => {
    try {
        await sourcesApi.deleteSource(tenant(req)._id, req.params.id);
        res.status(204).end();
    } catch (error) {
        handleError(res, error);
    }
};

exports.startRun = async (req, res) => {
    try {
        const run = await sourcesApi.startRun(tenant(req)._id, req.params.id, req.sourcesApi.keyRecord);
        res.status(202).json({ run });
    } catch (error) {
        handleError(res, error);
    }
};

exports.listRuns = async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        res.json({ runs: await sourcesApi.listRuns(tenant(req)._id, req.params.id, limit) });
    } catch (error) {
        handleError(res, error);
    }
};

exports.getRun = async (req, res) => {
    try {
        res.json(await sourcesApi.getRun(tenant(req)._id, req.params.runId));
    } catch (error) {
        handleError(res, error);
    }
};
