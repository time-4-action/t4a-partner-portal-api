/**
 * Middleware factory enforcing an early-access tier role ('alpha' / 'beta') on
 * JWT-authenticated requests — used on top of requireExportRole for features that are
 * still in a testing program. Roles come from the same Auth0 Post-Login-Action claim.
 *
 * The 403 carries `code: 'TIER_REQUIRED'` + the tier so the UI can show the
 * join-the-program screen instead of a generic error.
 */
function requireTier(tier) {
    return function (req, res, next) {
        const roles = req.auth?.payload['https://time-4-action.com/roles'] ?? [];
        if (!roles.includes(tier)) {
            return res.status(403).json({
                message: `This feature is in ${tier} testing — the '${tier}' role is required.`,
                code: 'TIER_REQUIRED',
                tier
            });
        }
        next();
    };
}

module.exports = requireTier;
