/**
 * Middleware that enforces the Auth0 'export' role on JWT-authenticated requests.
 * The role is injected into the access token via an Auth0 Post Login Action
 * under the claim 'https://time-4-action.com/roles'.
 *
 * API key requests bypass this check — a valid key is sufficient proof of
 * authorization (it was created by a role-bearing user).
 */
function requireExportRole(req, res, next) {
    const roles = req.auth?.payload['https://time-4-action.com/roles'] ?? [];
    if (!roles.includes('export')) {
        return res.status(403).json({ message: 'Export role required' });
    }
    next();
}

module.exports = requireExportRole;
