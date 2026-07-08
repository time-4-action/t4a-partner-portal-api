const exportsService = require("../services/exports.service");

exports.createExport = async (req, res) => {
    try {
        const { name, description, aiCategorizationEnabled, roles, users } = req.body;
        if (!name?.trim()) {
            return res.status(400).json({ success: false, message: 'name is required.' });
        }
        const data = await exportsService.createExport({ name: name.trim(), description, aiCategorizationEnabled, roles, users });
        res.status(201).json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateExport = async (req, res) => {
    try {
        const { id } = req.params;
        const data = await exportsService.updateExport(id, req.body);
        if (!data) return res.status(404).json({ success: false, message: 'Export not found.' });
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.deleteExport = async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await exportsService.deleteExport(id);
        if (!deleted) return res.status(404).json({ success: false, message: 'Export not found.' });
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getAllExports = async (req, res) => {
    try {
        const data = await exportsService.getAllExports();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

exports.getExportById = async (req, res) => {
    try {
        const { id } = req.params;
        const exportData = await exportsService.getExportById(id);
        if (!exportData) {
            return res.status(404).json({ success: false, message: `Export with id ${id} not found.` });
        }
        res.json({ success: true, data: exportData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}
// GET /exports/:id/ai-status — latest AI-categorization run for this category set.
// The UI polls this while a run is going to render live progress (batches/products/errors).
const { getRunStatus } = require("../services/ai/categoryIdentification.service");

exports.getAiStatus = async (req, res) => {
    try {
        const run = await getRunStatus(req.params.id);
        res.json({ success: true, run });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}
