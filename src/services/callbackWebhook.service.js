const axios = require('axios');

const CALLBACK_TIMEOUT_MS = 10000;

/**
 * Fires a POST request to a callback URL with the given payload.
 * Silently logs on failure — never throws, so a failed callback never
 * crashes the main job.
 *
 * @param {string} url - The callback URL (e.g. an n8n webhook URL).
 * @param {Object} payload - The JSON body to send.
 */
const fireCallback = async (url, payload) => {
    if (!url) return;

    try {
        await axios.post(url, payload, {
            timeout: CALLBACK_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json' },
        });
        console.log(`[callback] Successfully notified: ${url}`);
    } catch (error) {
        console.error(`[callback] Failed to notify ${url}:`, error.message);
    }
};

module.exports = { fireCallback };
