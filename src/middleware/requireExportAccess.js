const { getDb } = require('../services/db/mongo.service');
const { ObjectId } = require('mongodb');

const COLLECTION_NAME = 'export_configs';

/**
 * Middleware that verifies the requester has access to the export at req.params.id.
 *
 * Access rules:
 * - API key: req.authContext.exportId must match req.params.id
 * - JWT owner: config.owner.sub === sub
 * - JWT grantee: sub or email appears in config.accessList
 * - Legacy docs (owner.sub === null): accessible to all export-role users during transition
 *
 * Attaches config to req.exportConfig on success.
 */
async function requireExportAccess(req, res, next) {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid export ID' });
    }

    let config;
    try {
        const db = getDb();
        const collection = db.collection(COLLECTION_NAME);
        config = await collection.findOne({ _id: new ObjectId(id), isActive: true });
    } catch (err) {
        return res.status(500).json({ message: 'Server error' });
    }

    if (!config) {
        return res.status(404).json({ message: 'Export not found' });
    }

    // API key path
    if (req.authContext?.type === 'apikey') {
        if (req.authContext.exportId === id) {
            req.exportConfig = config;
            return next();
        }
        return res.status(403).json({ message: 'Forbidden' });
    }

    // JWT path — identity from dualAuth or directly from jwtCheck
    const sub = req.authContext?.sub || req.auth?.payload?.sub;
    const email = req.authContext?.email || req.auth?.payload?.email;

    // Legacy docs (owner not set or owner.sub is null) are open to all export-role users
    if (!config.owner || config.owner.sub === null || config.owner.sub === undefined) {
        req.exportConfig = config;
        return next();
    }

    const isOwner = config.owner.sub === sub;
    const inAccessListBySub = config.accessList?.some(a => a.sub === sub);
    const inAccessListByEmail = email && config.accessList?.some(a => a.email === email && a.sub === null);

    if (isOwner || inAccessListBySub || inAccessListByEmail) {
        // Lazy-fill sub for email-only access entries
        if (inAccessListByEmail && !inAccessListBySub && sub) {
            try {
                const db = getDb();
                db.collection(COLLECTION_NAME).updateOne(
                    { _id: new ObjectId(id), 'accessList.email': email, 'accessList.sub': null },
                    { $set: { 'accessList.$.sub': sub } }
                ).catch(() => {});
            } catch (_) {}
        }
        req.exportConfig = config;
        return next();
    }

    return res.status(403).json({ message: 'Forbidden' });
}

/**
 * Middleware that enforces owner-only access.
 * Must run after requireExportAccess (relies on req.exportConfig).
 * Legacy docs (owner.sub === null) are treated as ownerless and pass through,
 * consistent with requireExportAccess behaviour during the migration period.
 */
function requireOwner(req, res, next) {
    const config = req.exportConfig;

    if (!config) {
        return res.status(403).json({ message: 'Owner access required' });
    }

    // Legacy docs (owner not set or owner.sub is null) — no owner to enforce
    if (!config.owner || config.owner.sub === null || config.owner.sub === undefined) {
        return next();
    }

    const sub = req.authContext?.sub || req.auth?.payload?.sub;

    if (config.owner.sub !== sub) {
        return res.status(403).json({ message: 'Owner access required' });
    }
    next();
}

module.exports = { requireExportAccess, requireOwner };
