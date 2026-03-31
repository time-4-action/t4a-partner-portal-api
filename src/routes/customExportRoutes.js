const express = require('express');
const router = express.Router();

const jwtCheck = require('../middleware/auth0');
const requireExportRole = require('../middleware/requireExportRole');
const dualAuth = require('../middleware/dualAuth');
const { requireExportAccess, requireOwner } = require('../middleware/requireExportAccess');

const customExportController = require('../controllers/customExportController');
const apiKeyController = require('../controllers/apiKeyController');
const accessController = require('../controllers/accessController');

// ─── JWT-only CRUD (require 'export' role) ────────────────────────────────────

router.post('/',
    jwtCheck, requireExportRole,
    customExportController.createConfig
);

router.get('/',
    jwtCheck, requireExportRole,
    customExportController.getAllConfigs
);

router.get('/:id',
    jwtCheck, requireExportRole, requireExportAccess,
    customExportController.getConfigById
);

router.put('/:id',
    jwtCheck, requireExportRole, requireExportAccess, requireOwner,
    customExportController.updateConfig
);

router.delete('/:id',
    jwtCheck, requireExportRole, requireExportAccess, requireOwner,
    customExportController.deleteConfig
);

// ─── Dual-auth download endpoints (JWT with role OR valid API key) ────────────

router.get('/:id/csv',
    dualAuth, requireExportAccess,
    customExportController.generateCsv
);

router.get('/:id/json',
    dualAuth, requireExportAccess,
    customExportController.generateJson
);

router.get('/:id/xml',
    dualAuth, requireExportAccess,
    customExportController.generateXml
);

// ─── API key management (JWT only, owner only) ────────────────────────────────

router.get('/:id/keys',
    jwtCheck, requireExportRole, requireExportAccess, requireOwner,
    apiKeyController.listKeys
);

router.post('/:id/keys',
    jwtCheck, requireExportRole, requireExportAccess, requireOwner,
    apiKeyController.createKey
);

router.delete('/:id/keys/:keyId',
    jwtCheck, requireExportRole, requireExportAccess, requireOwner,
    apiKeyController.revokeKey
);

// ─── Access management (JWT only, owner only) ─────────────────────────────────

router.get('/:id/access',
    jwtCheck, requireExportRole, requireExportAccess, requireOwner,
    accessController.listAccess
);

router.post('/:id/access',
    jwtCheck, requireExportRole, requireExportAccess, requireOwner,
    accessController.grantAccess
);

router.delete('/:id/access/:email',
    jwtCheck, requireExportRole, requireExportAccess, requireOwner,
    accessController.revokeAccess
);

module.exports = router;
