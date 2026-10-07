/**
 * Non-blocking middleware that flags requests carrying the trusted API key.
 *
 * Unlike `webhookApiKey`, this never rejects a request — it only sets
 * `req.hasFullAccess = true` when the caller passes a valid key in the
 * `x-api-key` header (matching WEBHOOK_API_KEY). Downstream handlers use the
 * flag to widen results to unpublished / inactive products, while anonymous
 * callers keep the default published-only view.
 */
const detectApiKey = (req, res, next) => {
    const expectedKey = process.env.WEBHOOK_API_KEY;
    const providedKey = req.headers['x-api-key'];

    req.hasFullAccess = Boolean(expectedKey && providedKey && providedKey === expectedKey);

    next();
};

module.exports = detectApiKey;
