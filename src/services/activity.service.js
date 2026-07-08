const { getDb } = require('./db/mongo.service');

/**
 * Partner activity instrumentation.
 *
 * Writes a unified, append-only event stream (`activity_log`) plus a small
 * per-partner rollup (`partner_activity`) that the admin Partners section reads
 * back through the `/api/admin/partners/*` surface. Every write here is
 * fire-and-forget — instrumentation must never break the request it observes,
 * so failures are swallowed and logged (same posture as the legacy
 * analytics.service.js stub).
 */

const ACTIVITY_COLLECTION = 'activity_log';
const ROLLUP_COLLECTION = 'partner_activity';

/** Allowed event types — keep in sync with the admin "most interacted with" UI. */
const EVENT_TYPES = Object.freeze([
    'login',
    'export_download',
    'shopify_connect',
    'shopify_sync_now',
    'feed_add',
    'feed_test',
    'feed_import',
    'product_view',
    'config_change'
]);

// A login row is only written when the partner has been idle longer than this,
// so a busy session produces one "login" event rather than one per request.
const LOGIN_GAP_MS = 30 * 60 * 1000;

/**
 * Append one activity event. Never throws into the caller.
 * @param {string} eventType one of EVENT_TYPES
 * @param {{ ownerSub:string, email?:string, resourceType?:string, resourceId?:string, metadata?:object }} ctx
 */
async function recordActivity(eventType, { ownerSub, email = null, resourceType = null, resourceId = null, metadata = {} } = {}) {
    if (!ownerSub) return; // anonymous / api-key-without-owner traffic is not attributed
    try {
        await getDb().collection(ACTIVITY_COLLECTION).insertOne({
            ownerSub,
            email,
            eventType,
            resourceType,
            resourceId: resourceId != null ? String(resourceId) : null,
            metadata,
            timestamp: new Date()
        });
    } catch (err) {
        console.error('[activity] recordActivity failed:', err.message);
    }
}

/**
 * Bump a partner's last-active timestamp on every authenticated request, and
 * emit a `login` event when they return after being idle (see LOGIN_GAP_MS).
 * Fire-and-forget; never throws.
 * @param {string} ownerSub Auth0 sub
 * @param {string} [email]
 */
async function touchLastActive(ownerSub, email = null) {
    if (!ownerSub) return;
    try {
        const db = getDb();
        const now = new Date();
        const prev = await db.collection(ROLLUP_COLLECTION).findOne(
            { ownerSub },
            { projection: { lastActiveAt: 1 } }
        );
        const isNewSession = !prev?.lastActiveAt || (now - new Date(prev.lastActiveAt)) > LOGIN_GAP_MS;

        await db.collection(ROLLUP_COLLECTION).updateOne(
            { ownerSub },
            {
                $set: { ownerSub, email, lastActiveAt: now },
                ...(isNewSession ? { $inc: { loginCount: 1 } } : {})
            },
            { upsert: true }
        );

        if (isNewSession) {
            await recordActivity('login', { ownerSub, email });
        }
    } catch (err) {
        console.error('[activity] touchLastActive failed:', err.message);
    }
}

/**
 * Creates indexes for the activity collections. Called once at startup.
 */
async function ensureIndexes() {
    try {
        const db = getDb();
        await db.collection(ACTIVITY_COLLECTION).createIndex({ ownerSub: 1, timestamp: -1 });
        await db.collection(ACTIVITY_COLLECTION).createIndex({ ownerSub: 1, eventType: 1 });
        await db.collection(ROLLUP_COLLECTION).createIndex({ ownerSub: 1 }, { unique: true });
        await db.collection('partner_notes').createIndex({ ownerSub: 1, createdAt: -1 });
        console.log('[activity] Activity indexes ensured.');
    } catch (err) {
        console.error('[activity] Index creation error:', err.message);
    }
}

module.exports = {
    ACTIVITY_COLLECTION,
    ROLLUP_COLLECTION,
    EVENT_TYPES,
    recordActivity,
    touchLastActive,
    ensureIndexes
};
