/**
 * Guards the internal admin surface (`/api/admin/partners/*`) with a shared
 * bearer token. The t4a-admin app calls these endpoints server-side with
 * `Authorization: Bearer <PARTNER_ADMIN_TOKEN>`; the token never reaches a
 * browser. Mirrors webhookApiKey.js but for a bearer header.
 */
const internalAdminToken = (req, res, next) => {
    const expected = process.env.PARTNER_ADMIN_TOKEN;

    if (!expected) {
        console.error('PARTNER_ADMIN_TOKEN is not set in environment variables.');
        return res.status(500).json({ message: 'Admin token not configured on server.' });
    }

    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!provided || provided !== expected) {
        return res.status(401).json({ message: 'Unauthorized: invalid or missing bearer token.' });
    }

    req.adminContext = { type: 'internal_admin' };
    next();
};

module.exports = internalAdminToken;
