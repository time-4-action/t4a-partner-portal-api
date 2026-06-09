const crypto = require('crypto');

/**
 * Cryptographic helpers for the Shopify OAuth layer.
 *
 * Three independent concerns live here:
 *   1. Access-token encryption at rest (AES-256-GCM)   — SHOPIFY_TOKEN_ENC_KEY
 *   2. OAuth `state` nonce signing (HMAC-SHA256)        — SHOPIFY_STATE_SECRET
 *   3. Request HMAC verification (OAuth callback query + webhook body) — SHOPIFY_API_SECRET
 *
 * Nothing here logs token or key material.
 */

const ENC_VERSION = 'v1';

/**
 * Returns the 32-byte AES key from SHOPIFY_TOKEN_ENC_KEY (64 hex chars).
 * @returns {Buffer}
 */
function getEncKey() {
    const hex = process.env.SHOPIFY_TOKEN_ENC_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('SHOPIFY_TOKEN_ENC_KEY must be set to 64 hex characters (32 bytes).');
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext access token with AES-256-GCM.
 * @param {string} plaintext
 * @returns {string} `v1:<iv>:<authTag>:<ciphertext>` (each segment base64)
 */
function encryptToken(plaintext) {
    const key = getEncKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [ENC_VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypts a token produced by {@link encryptToken}.
 * @param {string} encoded
 * @returns {string} plaintext token
 */
function decryptToken(encoded) {
    const key = getEncKey();
    const [version, ivB64, tagB64, dataB64] = String(encoded).split(':');
    if (version !== ENC_VERSION || !ivB64 || !tagB64 || !dataB64) {
        throw new Error('Malformed encrypted token.');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function base64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getStateSecret() {
    const secret = process.env.SHOPIFY_STATE_SECRET;
    if (!secret) throw new Error('SHOPIFY_STATE_SECRET must be set.');
    return secret;
}

/**
 * Signs an OAuth `state` nonce bound to the connecting portal user and shop.
 * Format: `<base64url(payloadJson)>.<base64url(hmac)>`.
 * @param {{ sub: string, email?: string|null, shop: string }} data
 * @returns {string}
 */
function signState(data) {
    const payload = {
        sub: data.sub,
        email: data.email || null,
        shop: data.shop,
        nonce: crypto.randomBytes(16).toString('hex'),
        ts: Date.now()
    };
    const body = base64url(JSON.stringify(payload));
    const sig = base64url(crypto.createHmac('sha256', getStateSecret()).update(body).digest());
    return `${body}.${sig}`;
}

/**
 * Verifies a `state` value and returns its payload, or throws.
 * Rejects bad signatures and states older than `maxAgeMs` (default 10 min).
 * @param {string} state
 * @param {number} [maxAgeMs]
 * @returns {{ sub: string, email: string|null, shop: string, nonce: string, ts: number }}
 */
function verifyState(state, maxAgeMs = 10 * 60 * 1000) {
    const [body, sig] = String(state).split('.');
    if (!body || !sig) throw new Error('Malformed state.');
    const expected = base64url(crypto.createHmac('sha256', getStateSecret()).update(body).digest());
    if (!timingSafeEqualStr(sig, expected)) throw new Error('Invalid state signature.');
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload.ts || Date.now() - payload.ts > maxAgeMs) throw new Error('State expired.');
    return payload;
}

/**
 * Verifies the HMAC on an OAuth callback query string.
 * Shopify signs all params except `hmac`/`signature`, sorted, joined `k=v&k=v`,
 * HMAC-SHA256 with the app secret, hex-encoded.
 * @param {Object} query - parsed query params
 * @returns {boolean}
 */
function verifyOAuthHmac(query) {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) throw new Error('SHOPIFY_API_SECRET must be set.');
    const { hmac, signature, ...rest } = query;
    if (!hmac) return false;
    const message = Object.keys(rest)
        .sort()
        .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
        .join('&');
    const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return timingSafeEqualStr(digest, String(hmac));
}

/**
 * Verifies a Shopify webhook HMAC (`X-Shopify-Hmac-Sha256`) against the raw body.
 * @param {Buffer|string} rawBody - the exact bytes Shopify sent (NOT re-serialized JSON)
 * @param {string} hmacHeader - base64 HMAC from the request header
 * @returns {boolean}
 */
function verifyWebhookHmac(rawBody, hmacHeader) {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) throw new Error('SHOPIFY_API_SECRET must be set.');
    if (!rawBody || !hmacHeader) return false;
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    return timingSafeEqualStr(digest, String(hmacHeader));
}

/**
 * Constant-time string comparison that never throws on length mismatch.
 */
function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
    encryptToken,
    decryptToken,
    signState,
    verifyState,
    verifyOAuthHmac,
    verifyWebhookHmac
};
