const apiKeyService = require('../services/apiKey.service');

const ERROR_STATUS_MAP = {
    'INVALID_ID': 400,
    'NOT_FOUND': 404,
    'SERVER_ERROR': 500
};

const handleError = (res, error) => {
    const status = ERROR_STATUS_MAP[error.code] || 500;
    res.status(status).json({
        success: false,
        error: error.message,
        code: error.code || 'SERVER_ERROR'
    });
};

/**
 * GET /custom-export/:id/keys — list API keys (no hashes)
 */
exports.listKeys = async (req, res) => {
    try {
        const keys = await apiKeyService.listApiKeys(req.params.id);
        res.json({ success: true, data: keys });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * POST /custom-export/:id/keys — create a new API key
 * Body: { name: string }
 * Returns rawKey once — not stored, shown only in this response.
 */
exports.createKey = async (req, res) => {
    try {
        const { name } = req.body;
        const createdBySub = req.authContext?.sub || req.auth?.payload?.sub;
        const { rawKey, keyRecord } = await apiKeyService.createApiKey(req.params.id, name, createdBySub);
        res.status(201).json({
            success: true,
            warning: 'Save this key — it will not be shown again.',
            data: { ...keyRecord, rawKey }
        });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * DELETE /custom-export/:id/keys/:keyId — revoke an API key
 */
exports.revokeKey = async (req, res) => {
    try {
        await apiKeyService.revokeApiKey(req.params.id, req.params.keyId);
        res.json({ success: true, message: 'API key revoked' });
    } catch (error) {
        handleError(res, error);
    }
};
