const jwtCheck = require('./auth0');
const apiKeyService = require('../services/apiKey.service');

/**
 * Dual-auth middleware: tries JWT first, falls back to API key.
 * Sets req.authContext with { type, sub, email? } on success.
 *
 * JWT auth:   Authorization: Bearer <token>   → checks export role via jwtCheck
 * API key:    X-Api-Key: <key>  (header)  OR  { "api_key": "<key>" }  (request body)
 */
async function dualAuth(req, res, next) {
    // Try JWT first
    if (req.headers.authorization?.startsWith('Bearer ')) {
        return jwtCheck(req, res, (err) => {
            if (err) return res.status(401).json({ message: 'Unauthorized' });
            const payload = req.auth?.payload || {};
            req.authContext = {
                type: 'jwt',
                sub: payload.sub,
                email: payload.email
            };
            return next();
        });
    }

    // Try API key — header takes priority over body, query params are not accepted
    const rawKey = req.headers['x-api-key'] || req.body?.api_key;
    if (rawKey) {
        try {
            const result = await apiKeyService.verifyApiKey(rawKey);
            if (!result) return res.status(401).json({ message: 'Invalid API key' });
            req.authContext = {
                type: 'apikey',
                sub: `apikey:${result.keyId}`,
                exportId: result.exportConfig._id.toString()
            };
            return next();
        } catch (err) {
            return res.status(500).json({ message: 'Authentication error' });
        }
    }

    return res.status(401).json({ message: 'Authentication required' });
}

module.exports = dualAuth;
