const { ObjectId } = require('mongodb');
const { getDb } = require('../services/db/mongo.service');

/**
 * Read-only insight surface for the t4a-admin "Partners" section. Every endpoint
 * is gated by internalAdminToken (shared bearer) and aggregates the partner
 * portal's own collections, keyed by Auth0 `sub` (the partner identity). Secrets
 * (Shopify tokens, feed auth tokens) are never included in any response.
 */

const DOWNLOADS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Drops encrypted tokens / claim hashes from a connection doc. */
function publicConnection(c) {
    if (!c) return c;
    const { accessTokenEnc, refreshTokenEnc, claimTokenHash, ...rest } = c;
    return { ...rest, _id: c._id?.toString?.() ?? c._id };
}

/** Drops the feed auth token from an own_source doc. */
function publicFeed(f) {
    if (!f) return f;
    const feed = f.feed ? { url: f.feed.url, authHeaderName: f.feed.authHeaderName || null } : null;
    return { ...f, _id: f._id?.toString?.() ?? f._id, feed };
}

/**
 * GET /api/admin/partners/overview[?subs=a,b,c]
 * Per-partner activity rollup. Returns an array keyed by ownerSub; the admin
 * app left-joins it onto the Auth0 export-role user list.
 */
exports.overview = async (req, res) => {
    try {
        const db = getDb();
        const subsFilter = (req.query.subs || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const match = subsFilter.length ? { ownerSub: { $in: subsFilter } } : {};
        const ownerMatch = subsFilter.length ? { 'owner.sub': { $in: subsFilter } } : {};
        const since = new Date(Date.now() - DOWNLOADS_WINDOW_MS);

        const [connAgg, feedAgg, exportAgg, downloadAgg, rollups, topEventsAgg] = await Promise.all([
            db.collection('shopify_connections').aggregate([
                { $match: { ...match, status: { $ne: 'uninstalled' } } },
                { $sort: { lastSyncAt: -1 } },
                { $group: {
                    _id: '$ownerSub',
                    total: { $sum: 1 },
                    active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                    lastSyncAt: { $max: '$lastSyncAt' },
                    lastSyncStatus: { $first: '$lastSyncStatus' },
                    email: { $first: '$ownerEmail' }
                } }
            ]).toArray(),
            db.collection('own_sources').aggregate([
                { $match: match },
                { $sort: { 'health.lastImportAt': -1 } },
                { $group: {
                    _id: '$ownerSub',
                    total: { $sum: 1 },
                    active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                    lastImportAt: { $max: '$health.lastImportAt' },
                    lastResult: { $first: '$health.lastResult' },
                    email: { $first: '$ownerEmail' }
                } }
            ]).toArray(),
            db.collection('export_configs').aggregate([
                { $match: ownerMatch },
                { $group: { _id: '$owner.sub', configs: { $sum: 1 }, email: { $first: '$owner.email' } } }
            ]).toArray(),
            db.collection('activity_log').aggregate([
                { $match: { ...match, eventType: 'export_download', timestamp: { $gte: since } } },
                { $group: { _id: '$ownerSub', downloads30d: { $sum: 1 } } }
            ]).toArray(),
            db.collection('partner_activity').find(match).toArray(),
            db.collection('activity_log').aggregate([
                { $match: match },
                { $group: { _id: { ownerSub: '$ownerSub', eventType: '$eventType' }, count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray()
        ]);

        const map = new Map();
        const ensure = (sub, email) => {
            if (!sub) return null;
            if (!map.has(sub)) {
                map.set(sub, {
                    ownerSub: sub,
                    email: email || null,
                    shopifyConnections: { total: 0, active: 0, lastSyncAt: null, lastSyncStatus: null },
                    exports: { configs: 0, downloads30d: 0 },
                    feeds: { total: 0, active: 0, lastImportAt: null, lastResult: null },
                    lastActiveAt: null,
                    loginCount: 0,
                    topEvents: []
                });
            }
            const row = map.get(sub);
            if (email && !row.email) row.email = email;
            return row;
        };

        for (const c of connAgg) {
            const row = ensure(c._id, c.email);
            if (row) row.shopifyConnections = { total: c.total, active: c.active, lastSyncAt: c.lastSyncAt || null, lastSyncStatus: c.lastSyncStatus || null };
        }
        for (const f of feedAgg) {
            const row = ensure(f._id, f.email);
            if (row) row.feeds = { total: f.total, active: f.active, lastImportAt: f.lastImportAt || null, lastResult: f.lastResult || null };
        }
        for (const e of exportAgg) {
            const row = ensure(e._id, e.email);
            if (row) row.exports.configs = e.configs;
        }
        for (const d of downloadAgg) {
            const row = ensure(d._id);
            if (row) row.exports.downloads30d = d.downloads30d;
        }
        for (const r of rollups) {
            const row = ensure(r.ownerSub, r.email);
            if (row) { row.lastActiveAt = r.lastActiveAt || null; row.loginCount = r.loginCount || 0; }
        }
        for (const t of topEventsAgg) {
            const row = ensure(t._id.ownerSub);
            if (row && row.topEvents.length < 5) row.topEvents.push({ eventType: t._id.eventType, count: t.count });
        }

        res.json({ success: true, partners: Array.from(map.values()) });
    } catch (error) {
        console.error('[admin/partners] overview error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * GET /api/admin/partners/:sub
 * Full detail for one partner: connections, recent sync jobs, feeds, export
 * configs, recent downloads, and a "most interacted with" breakdown.
 */
exports.detail = async (req, res) => {
    try {
        const db = getDb();
        const sub = req.params.sub;
        const since = new Date(Date.now() - DOWNLOADS_WINDOW_MS);

        const connections = (await db.collection('shopify_connections')
            .find({ ownerSub: sub, status: { $ne: 'uninstalled' } })
            .sort({ installedAt: 1 })
            .toArray()).map(publicConnection);

        const connIds = connections.map((c) => new ObjectId(c._id));
        const syncJobs = connIds.length
            ? await db.collection('shopify_sync_jobs')
                .find({ connectionId: { $in: connIds } })
                .sort({ startedAt: -1 })
                .limit(20)
                .toArray()
            : [];

        const feeds = (await db.collection('own_sources')
            .find({ ownerSub: sub })
            .sort({ createdAt: 1 })
            .toArray()).map(publicFeed);

        const exportConfigs = await db.collection('export_configs')
            .find({ $or: [{ 'owner.sub': sub }, { 'accessList.sub': sub }] })
            .project({ name: 1, description: 1, isActive: 1, preset: 1, createdAt: 1, updatedAt: 1, 'owner.sub': 1 })
            .toArray();

        const recentDownloads = await db.collection('activity_log')
            .find({ ownerSub: sub, eventType: 'export_download' })
            .sort({ timestamp: -1 })
            .limit(20)
            .toArray();

        const [eventBreakdown, topExports, rollup] = await Promise.all([
            db.collection('activity_log').aggregate([
                { $match: { ownerSub: sub } },
                { $group: { _id: '$eventType', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray(),
            db.collection('activity_log').aggregate([
                { $match: { ownerSub: sub, eventType: 'export_download', timestamp: { $gte: since } } },
                { $group: { _id: '$resourceId', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 5 }
            ]).toArray(),
            db.collection('partner_activity').findOne({ ownerSub: sub })
        ]);

        // Resolve export-config names for the top-exports breakdown.
        const cfgById = new Map(exportConfigs.map((c) => [c._id.toString(), c.name]));

        res.json({
            success: true,
            partner: {
                ownerSub: sub,
                email: rollup?.email || connections[0]?.ownerEmail || null,
                lastActiveAt: rollup?.lastActiveAt || null,
                loginCount: rollup?.loginCount || 0,
                connections,
                syncJobs,
                feeds,
                exportConfigs,
                recentDownloads,
                mostInteractedWith: {
                    events: eventBreakdown.map((e) => ({ eventType: e._id, count: e.count })),
                    topExports: topExports.map((t) => ({
                        exportConfigId: t._id,
                        name: cfgById.get(String(t._id)) || null,
                        downloads: t.count
                    }))
                }
            }
        });
    } catch (error) {
        console.error('[admin/partners] detail error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/** GET /api/admin/partners/:sub/activity?limit=100 — reverse-chron event stream. */
exports.activity = async (req, res) => {
    try {
        const db = getDb();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const events = await db.collection('activity_log')
            .find({ ownerSub: req.params.sub })
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();
        res.json({ success: true, events });
    } catch (error) {
        console.error('[admin/partners] activity error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/** GET /api/admin/partners/:sub/notes — newest first. */
exports.listNotes = async (req, res) => {
    try {
        const db = getDb();
        const notes = await db.collection('partner_notes')
            .find({ ownerSub: req.params.sub })
            .sort({ createdAt: -1 })
            .toArray();
        res.json({ success: true, notes });
    } catch (error) {
        console.error('[admin/partners] listNotes error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * POST /api/admin/partners/:sub/notes
 * Body: { text, authorName, authorEmail }. Author identity is stamped by the
 * admin app from its Auth0 session and trusted via the shared token.
 */
exports.addNote = async (req, res) => {
    try {
        const { text, authorName, authorEmail } = req.body || {};
        if (!text || !String(text).trim()) {
            return res.status(400).json({ success: false, error: 'text is required' });
        }
        const db = getDb();
        const doc = {
            ownerSub: req.params.sub,
            text: String(text).trim(),
            authorName: authorName || 'Admin',
            authorEmail: authorEmail || null,
            createdAt: new Date()
        };
        const result = await db.collection('partner_notes').insertOne(doc);
        res.status(201).json({ success: true, note: { ...doc, _id: result.insertedId.toString() } });
    } catch (error) {
        console.error('[admin/partners] addNote error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/** DELETE /api/admin/partners/:sub/notes/:noteId */
exports.deleteNote = async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.noteId)) {
            return res.status(400).json({ success: false, error: 'invalid note id' });
        }
        const db = getDb();
        const result = await db.collection('partner_notes').deleteOne({
            _id: new ObjectId(req.params.noteId),
            ownerSub: req.params.sub
        });
        if (result.deletedCount === 0) {
            return res.status(404).json({ success: false, error: 'note not found' });
        }
        res.json({ success: true });
    } catch (error) {
        console.error('[admin/partners] deleteNote error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};
