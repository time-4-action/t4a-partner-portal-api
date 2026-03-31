const accessControlService = require('../services/accessControl.service');

const ERROR_STATUS_MAP = {
    'INVALID_ID': 400,
    'NOT_FOUND': 404,
    'DUPLICATE_ACCESS': 409,
    'SERVER_ERROR': 500
};

const handleError = (res, error) => {
    const status = ERROR_STATUS_MAP[error.code] || 500;
    res.status(status).json({
        success: false,
        error: error.message,
        code: error.code || 'SERVER_ERROR'
    });
};

/**
 * GET /custom-export/:id/access — list access entries
 */
exports.listAccess = async (req, res) => {
    try {
        const entries = await accessControlService.listAccess(req.params.id);
        res.json({ success: true, data: entries });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * POST /custom-export/:id/access — grant access to a user by email
 * Body: { email: string }
 */
exports.grantAccess = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || typeof email !== 'string' || !email.trim()) {
            return res.status(400).json({ success: false, error: 'Email is required', code: 'VALIDATION_ERROR' });
        }
        const grantorSub = req.authContext?.sub || req.auth?.payload?.sub;
        const entry = await accessControlService.grantAccess(req.params.id, email.trim().toLowerCase(), grantorSub);
        res.status(201).json({ success: true, data: entry });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * DELETE /custom-export/:id/access/:email — revoke access for a user
 */
exports.revokeAccess = async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email);
        await accessControlService.revokeAccess(req.params.id, email);
        res.json({ success: true, message: 'Access revoked' });
    } catch (error) {
        handleError(res, error);
    }
};
