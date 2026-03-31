const customExportService = require('../services/customExport.service');

/**
 * Error code to HTTP status mapping
 */
const ERROR_STATUS_MAP = {
    'VALIDATION_ERROR': 400,
    'INVALID_ID': 400,
    'NOT_FOUND': 404,
    'DUPLICATE_NAME': 409,
    'SERVER_ERROR': 500
};

/**
 * Handles errors and sends appropriate response
 * @param {Object} res - Express response object
 * @param {Error} error - Error object
 */
const handleError = (res, error) => {
    const status = ERROR_STATUS_MAP[error.code] || 500;
    const response = {
        success: false,
        error: error.message,
        code: error.code || 'SERVER_ERROR'
    };
    if (error.details) {
        response.details = error.details;
    }
    res.status(status).json(response);
};

/**
 * POST /custom-export - Create a new export configuration
 */
exports.createConfig = async (req, res) => {
    try {
        const ownerContext = {
            sub: req.auth?.payload?.sub || null,
            email: req.auth?.payload?.email || null
        };
        const config = await customExportService.createExportConfig(req.body, ownerContext);
        res.status(201).json({ success: true, data: config });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /custom-export - List all export configurations
 */
exports.getAllConfigs = async (req, res) => {
    try {
        const options = {
            active: req.query.active !== 'false',
            preset: req.query.preset,
            limit: req.query.limit
        };

        // Handle sort parameter
        if (req.query.sort) {
            const sortField = req.query.sort.startsWith('-')
                ? req.query.sort.substring(1)
                : req.query.sort;
            const sortOrder = req.query.sort.startsWith('-') ? -1 : 1;
            options.sort = { [sortField]: sortOrder };
        }

        const authContext = {
            sub: req.auth?.payload?.sub,
            email: req.auth?.payload?.email
        };

        const configs = await customExportService.getAllExportConfigs(options, authContext);
        res.json({ success: true, count: configs.length, data: configs });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /custom-export/:id - Get a single export configuration
 */
exports.getConfigById = async (req, res) => {
    try {
        const config = await customExportService.getExportConfigById(req.params.id);
        if (!config) {
            return res.status(404).json({
                success: false,
                error: 'Export configuration not found',
                code: 'NOT_FOUND'
            });
        }
        res.json({ success: true, data: config });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * PUT /custom-export/:id - Update an export configuration
 */
exports.updateConfig = async (req, res) => {
    try {
        const config = await customExportService.updateExportConfig(req.params.id, req.body);
        res.json({ success: true, data: config });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * DELETE /custom-export/:id - Delete an export configuration
 */
exports.deleteConfig = async (req, res) => {
    try {
        const hard = req.query.hard === 'true';
        await customExportService.deleteExportConfig(req.params.id, hard);
        res.json({ success: true, message: 'Export configuration deleted' });
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /custom-export/:id/csv - Generate CSV export
 */
exports.generateCsv = async (req, res) => {
    try {
        const { csv, filename, config } = await customExportService.generateCsvExport(req.params.id);

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');

        if (req.query.download === 'true') {
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        }

        // Add BOM for Excel UTF-8 compatibility
        res.send('\ufeff' + csv);
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /custom-export/:id/json - Generate JSON export
 */
exports.generateJson = async (req, res) => {
    try {
        const data = await customExportService.generateJsonExport(req.params.id);
        res.json(data);
    } catch (error) {
        handleError(res, error);
    }
};

/**
 * GET /custom-export/:id/xml - Generate XML export
 */
exports.generateXml = async (req, res) => {
    try {
        const { xml, filename } = await customExportService.generateXmlExport(req.params.id);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        if (req.query.download === 'true') {
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        }
        res.send(xml);
    } catch (error) {
        handleError(res, error);
    }
};
