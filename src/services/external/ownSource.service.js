const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo.service');
const { encryptToken } = require('../shopify/crypto.service');

/**
 * Data-access layer for the `own_sources` collection — the feed registry (design §4.1).
 * One document per registered supplier feed. Owner-scoped: every read/write is keyed by the
 * caller's Auth0 `sub`. The feed's auth token is stored encrypted (reusing the Shopify crypto
 * helper) and NEVER returned over the API — {@link toPublic} strips it.
 */

const COLLECTION_NAME = 'own_sources';

/** Per-feed business options — safe, reversible defaults (design §12: E2/E4). */
const DEFAULT_OPTIONS = {
    defaultStatus: 'active', // status applied to a product missing `status`
    removalPolicy: 'delist', // delist | zero_stock | keep
    maxStalenessHours: 48, // reject a feed older than this
    allowEmptyFeed: false // wipe-guard: refuse an empty snapshot
};

/** Default schedule — the portal runs this itself (design §8.2). Disabled until the user opts in. */
const DEFAULT_SCHEDULE = {
    enabled: false,
    frequency: 'every_hours', // every_hours | daily | weekly
    everyHours: 6,
    timeOfDay: '03:00',
    weekday: 1, // 0=Sun … 6=Sat
    timezone: 'Europe/Ljubljana'
};

const REMOVAL_POLICIES = ['delist', 'zero_stock', 'keep'];
const FREQUENCIES = ['every_hours', 'daily', 'weekly'];

/** Slugifies a brand into a feed-id-friendly token. */
function slugify(s) {
    return String(s || 'feed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'feed';
}

/** Generates a stable public feed id (also used as the `source` tag and the import scope key). */
function generateFeedId(brand) {
    return `feed_${slugify(brand)}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * ── nextRunAt computation (pure, timezone-aware) ──────────────────────────────
 * Recomputed from the SCHEDULED time (not the actual finish) so cadence doesn't drift.
 */

/** Offset (ms) to add to a UTC instant to express it as wall-clock in `timeZone`. */
function tzOffsetMs(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : Number(p.hour), p.minute, p.second);
    return asUTC - date.getTime();
}

/** UTC ms for a given wall-clock (Y, M[0-11], D, h, m) in `timeZone`. */
function wallTimeToUtc(y, mo, d, h, mi, timeZone) {
    const guess = Date.UTC(y, mo, d, h, mi, 0);
    const off = tzOffsetMs(new Date(guess), timeZone);
    // One correction pass — good across all but the rare wall-clock-skipped DST instant.
    return guess - off;
}

/** Wall-clock parts (year, month[0-11], day, weekday[0-6]) of a UTC instant in `timeZone`. */
function wallPartsInTz(ms, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false, weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const p = dtf.formatToParts(new Date(ms)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { year: Number(p.year), month: Number(p.month) - 1, day: Number(p.day), weekday: WD[p.weekday] };
}

/**
 * Computes the next run instant (Date) for a schedule, strictly after `fromMs`.
 * Returns null when the schedule is disabled.
 *
 * @param {Object} schedule - the `own_sources.schedule` sub-doc
 * @param {number} [fromMs] - the reference time (defaults to now)
 * @returns {Date|null}
 */
function computeNextRunAt(schedule, fromMs = Date.now()) {
    if (!schedule || !schedule.enabled) return null;
    const tz = schedule.timezone || 'Europe/Ljubljana';

    if (schedule.frequency === 'every_hours') {
        const hours = Math.max(1, Number(schedule.everyHours) || 6);
        return new Date(fromMs + hours * 3600 * 1000);
    }

    const [hh, mm] = String(schedule.timeOfDay || '03:00').split(':').map((n) => Number(n) || 0);

    if (schedule.frequency === 'daily') {
        for (let addDays = 0; addDays <= 1; addDays++) {
            const base = wallPartsInTz(fromMs + addDays * 86400000, tz);
            const ms = wallTimeToUtc(base.year, base.month, base.day, hh, mm, tz);
            if (ms > fromMs) return new Date(ms);
        }
        // Fallback (shouldn't hit): a full day later.
        const b = wallPartsInTz(fromMs + 86400000, tz);
        return new Date(wallTimeToUtc(b.year, b.month, b.day, hh, mm, tz));
    }

    if (schedule.frequency === 'weekly') {
        const targetWd = Number(schedule.weekday);
        for (let addDays = 0; addDays <= 7; addDays++) {
            const base = wallPartsInTz(fromMs + addDays * 86400000, tz);
            if (base.weekday !== targetWd) continue;
            const ms = wallTimeToUtc(base.year, base.month, base.day, hh, mm, tz);
            if (ms > fromMs) return new Date(ms);
        }
    }
    return null;
}

/** Strips the encrypted token + internal lock fields before a feed leaves the service. */
function toPublic(doc) {
    if (!doc) return null;
    const { feed, lockedUntil, runningBy, ...rest } = doc;
    const safeFeed = feed
        ? { url: feed.url, authHeaderName: feed.authHeaderName || null, hasAuthToken: !!feed.authTokenEnc }
        : null;
    return { ...rest, _id: doc._id.toString(), feed: safeFeed };
}

/** Normalizes + clamps a caller-supplied options patch to the allowed shape. */
function sanitizeOptions(input = {}) {
    const out = {};
    if (typeof input.defaultStatus === 'string' && ['active', 'draft'].includes(input.defaultStatus)) out.defaultStatus = input.defaultStatus;
    if (REMOVAL_POLICIES.includes(input.removalPolicy)) out.removalPolicy = input.removalPolicy;
    if (Number.isFinite(input.maxStalenessHours) && input.maxStalenessHours > 0) out.maxStalenessHours = Math.floor(input.maxStalenessHours);
    if (typeof input.allowEmptyFeed === 'boolean') out.allowEmptyFeed = input.allowEmptyFeed;
    return out;
}

/** Normalizes a caller-supplied schedule patch. */
function sanitizeSchedule(input = {}) {
    const out = {};
    if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
    if (FREQUENCIES.includes(input.frequency)) out.frequency = input.frequency;
    if (Number.isFinite(input.everyHours) && input.everyHours >= 1) out.everyHours = Math.floor(input.everyHours);
    if (typeof input.timeOfDay === 'string' && /^\d{1,2}:\d{2}$/.test(input.timeOfDay)) out.timeOfDay = input.timeOfDay;
    if (Number.isInteger(input.weekday) && input.weekday >= 0 && input.weekday <= 6) out.weekday = input.weekday;
    if (typeof input.timezone === 'string' && input.timezone.length) out.timezone = input.timezone;
    return out;
}

/**
 * Registers a new feed for a user. Encrypts the optional auth token; computes the initial
 * `nextRunAt` from the schedule.
 * @returns {Promise<Object>} public-shaped feed
 */
async function createSource({ ownerSub, ownerEmail, brand, url, authHeaderName, authToken, schedule, options }) {
    const db = getDb();
    const now = new Date();
    const sched = { ...DEFAULT_SCHEDULE, ...sanitizeSchedule(schedule) };
    const doc = {
        ownerSub,
        ownerEmail: ownerEmail || null,
        feedId: generateFeedId(brand),
        brand,
        status: 'active', // active | paused | error
        feed: {
            url,
            authHeaderName: authHeaderName || null,
            authTokenEnc: authToken ? encryptToken(authToken) : null
        },
        schedule: sched,
        nextRunAt: computeNextRunAt(sched, now.getTime()),
        lockedUntil: null,
        runningBy: null,
        options: { ...DEFAULT_OPTIONS, ...sanitizeOptions(options) },
        health: {
            lastFetchAt: null, lastValidatedAt: null, lastImportAt: null,
            lastResult: null, lastError: null,
            counts: { products: 0, variants: 0, created: 0, updated: 0, removed: 0 }
        },
        createdAt: now,
        updatedAt: now
    };
    const res = await db.collection(COLLECTION_NAME).insertOne(doc);
    return toPublic({ ...doc, _id: res.insertedId });
}

/** Lists a user's feeds (public-shaped, secrets stripped), oldest-first. */
async function listSourcesForUser(ownerSub) {
    const db = getDb();
    const docs = await db.collection(COLLECTION_NAME).find({ ownerSub }).sort({ createdAt: 1 }).toArray();
    return docs.map(toPublic);
}

/** Returns one feed by feedId (public-shaped), or null. */
async function getSourceByFeedId(feedId) {
    const db = getDb();
    return toPublic(await db.collection(COLLECTION_NAME).findOne({ feedId }));
}

/** Returns the RAW feed doc (incl. encrypted token) by feedId — internal use only. */
async function getRawByFeedId(feedId) {
    const db = getDb();
    return db.collection(COLLECTION_NAME).findOne({ feedId });
}

/**
 * Applies a config patch to an owned feed. Whitelisted fields only. Recomputes `nextRunAt`
 * whenever the schedule changes so the UI's "Next run" stays truthful immediately.
 * @returns {Promise<Object>} public-shaped feed, or throws NOT_FOUND.
 */
async function updateSource(feedId, patch = {}) {
    const db = getDb();
    const existing = await db.collection(COLLECTION_NAME).findOne({ feedId });
    if (!existing) {
        const e = new Error('Feed not found'); e.code = 'NOT_FOUND'; throw e;
    }
    const set = { updatedAt: new Date() };
    if (typeof patch.brand === 'string' && patch.brand.trim()) set.brand = patch.brand.trim();
    if (['active', 'paused'].includes(patch.status)) set.status = patch.status;

    if (patch.feed) {
        if (typeof patch.feed.url === 'string' && patch.feed.url.trim()) set['feed.url'] = patch.feed.url.trim();
        if ('authHeaderName' in patch.feed) set['feed.authHeaderName'] = patch.feed.authHeaderName || null;
        // Token is write-only: only overwrite when a fresh value is supplied; '' clears it.
        if ('authToken' in patch.feed) {
            set['feed.authTokenEnc'] = patch.feed.authToken ? encryptToken(patch.feed.authToken) : null;
        }
    }
    if (patch.options) Object.assign(set, prefix('options', sanitizeOptions(patch.options)));
    if (patch.schedule) {
        const merged = { ...existing.schedule, ...sanitizeSchedule(patch.schedule) };
        Object.assign(set, prefix('schedule', sanitizeSchedule(patch.schedule)));
        set.nextRunAt = computeNextRunAt(merged, Date.now());
    }

    const res = await db.collection(COLLECTION_NAME).findOneAndUpdate(
        { feedId }, { $set: set }, { returnDocument: 'after' }
    );
    return toPublic(res.value || res);
}

/** Builds a dotted `$set` patch for a nested object (`{a:1}` → `{'k.a':1}`). */
function prefix(key, obj) {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${key}.${k}`, v]));
}

/** Hard-deletes a feed registry row. The caller also drops its external_products. */
async function deleteSource(feedId) {
    const db = getDb();
    const res = await db.collection(COLLECTION_NAME).deleteOne({ feedId });
    return res.deletedCount > 0;
}

/**
 * Records the outcome of an import on the feed's `health`, and (when scheduled) advances
 * `nextRunAt`. Always clears the scheduler lock.
 * @param {string} feedId
 * @param {{ result:string, error?:Object|null, counts?:Object, touchFetch?:boolean, touchValidate?:boolean }} h
 */
async function recordHealth(feedId, { result, error = null, counts, touchFetch = true, touchValidate = false }) {
    const db = getDb();
    const doc = await db.collection(COLLECTION_NAME).findOne({ feedId });
    if (!doc) return;
    const now = new Date();
    const set = {
        'health.lastResult': result,
        'health.lastError': error,
        lockedUntil: null,
        runningBy: null,
        updatedAt: now
    };
    if (touchFetch) set['health.lastFetchAt'] = now;
    if (touchValidate) set['health.lastValidatedAt'] = now;
    if (result === 'ok') {
        set['health.lastImportAt'] = now;
        if (counts) set['health.counts'] = counts;
    }
    set.status = result === 'ok' ? 'active' : 'error';
    // Advance the schedule from the SCHEDULED time so cadence doesn't drift on slow runs.
    if (doc.schedule?.enabled) {
        const base = doc.nextRunAt ? Math.max(doc.nextRunAt.getTime(), now.getTime() - 60000) : now.getTime();
        set.nextRunAt = computeNextRunAt(doc.schedule, base);
    }
    await db.collection(COLLECTION_NAME).updateOne({ feedId }, { $set: set });
}

/**
 * Atomically claims ONE due, enabled, active feed for the scheduler (design §8.2). The atomic
 * findOneAndUpdate IS the lock — safe even if the API scales to >1 instance. Returns the raw
 * claimed doc, or null when nothing is due.
 */
async function claimDueSource(nowMs, instanceId, lockMs) {
    const db = getDb();
    const now = new Date(nowMs);
    const res = await db.collection(COLLECTION_NAME).findOneAndUpdate(
        {
            'schedule.enabled': true,
            status: { $in: ['active', 'error'] },
            nextRunAt: { $ne: null, $lte: now },
            $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }]
        },
        { $set: { lockedUntil: new Date(nowMs + lockMs), runningBy: instanceId } },
        { sort: { nextRunAt: 1 }, returnDocument: 'after' }
    );
    return res.value || res;
}

const RUNS_COLLECTION = 'external_import_runs';

/**
 * Appends an import-run record (the activity history, design §9.2 SourceActivity). Best-effort:
 * a failed write never blocks the import. Capped read keeps the table light.
 */
async function recordRun(feedId, ownerSub, run) {
    try {
        await getDb().collection(RUNS_COLLECTION).insertOne({
            feedId, ownerSub,
            trigger: run.trigger || 'manual',
            result: run.result,
            counts: run.counts || null,
            error: run.error || null,
            startedAt: run.startedAt || new Date(),
            finishedAt: new Date()
        });
    } catch (e) {
        console.error('[external] recordRun failed:', e.message);
    }
}

/** Returns the most recent import runs for a feed, newest-first. */
async function listRuns(feedId, limit = 20) {
    return getDb().collection(RUNS_COLLECTION)
        .find({ feedId }).sort({ finishedAt: -1 }).limit(limit).toArray();
}

/** Creates indexes for own_sources + external_products. Called once at startup. */
async function ensureIndexes() {
    try {
        const db = getDb();
        await db.collection(COLLECTION_NAME).createIndex({ ownerSub: 1, feedId: 1 }, { unique: true });
        await db.collection(COLLECTION_NAME).createIndex({ feedId: 1 }, { unique: true });
        await db.collection(COLLECTION_NAME).createIndex({ ownerSub: 1 });
        await db.collection(COLLECTION_NAME).createIndex({ 'schedule.enabled': 1, nextRunAt: 1 });

        await db.collection('external_products').createIndex({ feedId: 1, externalId: 1 }, { unique: true });
        await db.collection('external_products').createIndex({ ownerSub: 1, feedId: 1 });
        await db.collection('external_products').createIndex({ feedId: 1, 'child_products.code': 1 });
        await db.collection('external_products').createIndex({ ownerSub: 1 });

        await db.collection(RUNS_COLLECTION).createIndex({ feedId: 1, finishedAt: -1 });
        console.log('[external] Own-source indexes ensured.');
    } catch (error) {
        console.error('[external] Index creation error:', error.message);
    }
}

module.exports = {
    COLLECTION_NAME,
    DEFAULT_OPTIONS,
    DEFAULT_SCHEDULE,
    computeNextRunAt,
    createSource,
    listSourcesForUser,
    getSourceByFeedId,
    getRawByFeedId,
    updateSource,
    deleteSource,
    recordHealth,
    recordRun,
    listRuns,
    claimDueSource,
    ensureIndexes,
    toPublic
};
