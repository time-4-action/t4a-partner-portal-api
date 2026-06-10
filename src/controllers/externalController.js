const ownSource = require('../services/external/ownSource.service');
const externalProducts = require('../services/external/externalProducts.service');
const externalImport = require('../services/external/externalImport.service');
const connectionService = require('../services/shopify/shopifyConnection.service');

/**
 * Controller for the "Own Sources" feed registry (design §8.1). Routes are JWT + export-role
 * gated; every feed is owner-checked here (mirrors `shopifyController`). The feed auth token is
 * write-only — never returned (stripped by `ownSource.toPublic`).
 */

const ERROR_STATUS_MAP = {
    VALIDATION_ERROR: 400,
    INVALID_ID: 400,
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    SYNC_BUSY: 409,
    SERVER_ERROR: 500
};

function handleError(res, error) {
    const status = ERROR_STATUS_MAP[error.code] || 500;
    if (status === 500) console.error('[external] error:', error);
    res.status(status).json({ success: false, error: error.message, code: error.code || 'SERVER_ERROR' });
}

function authUser(req) {
    return { sub: req.auth?.payload?.sub, email: req.auth?.payload?.email };
}

function validationError(message) {
    return Object.assign(new Error(message), { code: 'VALIDATION_ERROR' });
}

/** Loads a feed and asserts the JWT user owns it, else throws NOT_FOUND / FORBIDDEN. */
async function loadOwnedFeed(req) {
    const { sub } = authUser(req);
    const feed = await ownSource.getSourceByFeedId(req.params.feedId);
    if (!feed) throw Object.assign(new Error('Feed not found'), { code: 'NOT_FOUND' });
    if (feed.ownerSub !== sub) throw Object.assign(new Error('You do not own this feed'), { code: 'FORBIDDEN' });
    return feed;
}

/** GET /external/sources — the caller's feeds (secrets stripped). */
exports.list = async (req, res) => {
    try {
        const { sub } = authUser(req);
        const sources = await ownSource.listSourcesForUser(sub);
        res.json({ success: true, sources });
    } catch (error) {
        handleError(res, error);
    }
};

/** POST /external/sources — register a feed. */
exports.create = async (req, res) => {
    try {
        const { sub, email } = authUser(req);
        const { brand, url, authHeaderName, authToken, schedule, options } = req.body || {};
        if (!brand || typeof brand !== 'string') throw validationError('brand is required');
        if (!url || !/^https?:\/\//i.test(url)) throw validationError('a valid feed url is required');
        const created = await ownSource.createSource({
            ownerSub: sub, ownerEmail: email, brand: brand.trim(), url: url.trim(),
            authHeaderName, authToken, schedule, options
        });
        res.status(201).json({ success: true, source: created });
    } catch (error) {
        handleError(res, error);
    }
};

/** GET /external/sources/:feedId — one feed + health + last issues. */
exports.get = async (req, res) => {
    try {
        const feed = await loadOwnedFeed(req);
        res.json({ success: true, source: feed });
    } catch (error) {
        handleError(res, error);
    }
};

/** PUT /external/sources/:feedId — update config. */
exports.update = async (req, res) => {
    try {
        await loadOwnedFeed(req);
        const updated = await ownSource.updateSource(req.params.feedId, req.body || {});
        res.json({ success: true, source: updated });
    } catch (error) {
        handleError(res, error);
    }
};

/** DELETE /external/sources/:feedId — remove feed + its products + unlink connections. */
exports.remove = async (req, res) => {
    try {
        await loadOwnedFeed(req);
        const feedId = req.params.feedId;
        const removedProducts = await externalProducts.deleteByFeed(feedId);
        const unlinked = await connectionService.unlinkFeedFromConnections(feedId);
        await ownSource.deleteSource(feedId);
        res.json({ success: true, removedProducts, unlinkedConnections: unlinked });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * POST /external/sources/:feedId/test — fetch + validate ONLY (no write) for a stored feed.
 * POST /external/test — same, for a transient feed (`{ url, authHeaderName?, authToken? }`)
 *   so the Add-Source form can "Test & Save" before persisting any secret.
 */
exports.test = async (req, res) => {
    try {
        let feed;
        let maxStalenessHours;
        if (req.params.feedId) {
            const owned = await loadOwnedFeed(req);
            const raw = await ownSource.getRawByFeedId(req.params.feedId);
            feed = raw.feed;
            maxStalenessHours = owned.options?.maxStalenessHours;
        } else {
            const { url, authHeaderName, authToken } = req.body || {};
            if (!url || !/^https?:\/\//i.test(url)) throw validationError('a valid feed url is required');
            feed = { url, authHeaderName, authToken };
        }
        const result = await externalImport.testFeed(feed, { maxStalenessHours });
        res.json({ success: true, ...result });
    } catch (error) {
        handleError(res, error);
    }
};

/** POST /external/sources/:feedId/import — trigger an import now (202; 409 if running). */
exports.importNow = async (req, res) => {
    try {
        await loadOwnedFeed(req);
        const feedId = req.params.feedId;
        if (externalImport.isBusy(feedId)) {
            throw Object.assign(new Error('An import is already running for this feed'), { code: 'SYNC_BUSY' });
        }
        // Fire-and-forget; the run records its own outcome on the feed's health + run history.
        externalImport.startImport(feedId, { trigger: 'manual' }).catch((err) => {
            console.error(`[external] import for ${feedId} failed:`, err.message);
        });
        res.status(202).json({ success: true, message: 'Import started' });
    } catch (error) {
        handleError(res, error);
    }
};

/** GET /external/sources/:feedId/activity — import history + current health. */
exports.activity = async (req, res) => {
    try {
        const feed = await loadOwnedFeed(req);
        const runs = await ownSource.listRuns(req.params.feedId, 20);
        res.json({
            success: true,
            health: feed.health,
            runs: runs.map((r) => ({
                id: r._id.toString(),
                trigger: r.trigger,
                result: r.result,
                counts: r.counts,
                error: r.error,
                time: (r.finishedAt || r.startedAt)?.toISOString?.() || null
            }))
        });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /external/sources/:feedId/products — the feed's imported products in the internal shape,
 * for the preview drawer. Owner-checked; returns the full imported catalogue (incl. delisted).
 */
exports.products = async (req, res) => {
    try {
        await loadOwnedFeed(req);
        const products = await externalProducts.listByFeed(req.params.feedId);
        res.json({ success: true, count: products.length, products });
    } catch (error) {
        handleError(res, error);
    }
};
