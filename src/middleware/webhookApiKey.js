/**
 * Middleware that protects webhook endpoints with a static API key.
 * The key is read from the WEBHOOK_API_KEY environment variable and must be
 * passed by the caller in the x-api-key request header.
 */
const webhookApiKey = (req, res, next) => {
    const expectedKey = process.env.WEBHOOK_API_KEY;

    if (!expectedKey) {
        console.error('WEBHOOK_API_KEY is not set in environment variables.');
        return res.status(500).json({ message: 'Webhook API key not configured on server.' });
    }

    const providedKey = req.headers['x-api-key'];

    if (!providedKey || providedKey !== expectedKey) {
        return res.status(401).json({ message: 'Unauthorized: invalid or missing x-api-key header.' });
    }

    next();
};

module.exports = webhookApiKey;
