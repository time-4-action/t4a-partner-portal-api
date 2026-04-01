const categoriesService = require('../services/categories.service');

exports.getAllCategories = async (req, res) => {
    try {
        const data = await categoriesService.getAllCategories();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getCategoriesByExportId = async (req, res) => {
    try {
        const { exportId } = req.params;
        const data = await categoriesService.getCategoriesByExportId(exportId);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.createCategory = async (req, res) => {
    try {
        const { exportId, label } = req.body;
        if (!exportId || !label) {
            return res.status(400).json({ success: false, message: 'exportId and label are required.' });
        }
        const data = await categoriesService.createCategory(exportId, label.trim());
        res.status(201).json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.importCategories = async (req, res) => {
    try {
        const { exportId, categories } = req.body;
        if (!exportId || !Array.isArray(categories) || categories.length === 0) {
            return res.status(400).json({ success: false, message: 'exportId and a non-empty categories array are required.' });
        }
        const items = categories
            .filter(c => c && typeof c.label === 'string' && c.label.trim())
            .map(c => ({ exportId, label: c.label.trim() }));
        if (!items.length) {
            return res.status(400).json({ success: false, message: 'No valid category labels found.' });
        }
        const count = await categoriesService.createManyCategories(items);
        res.status(201).json({ success: true, inserted: count });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const { label } = req.body;
        if (!label) {
            return res.status(400).json({ success: false, message: 'label is required.' });
        }
        const data = await categoriesService.updateCategory(id, label.trim());
        if (!data) {
            return res.status(404).json({ success: false, message: 'Category not found.' });
        }
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await categoriesService.deleteCategory(id);
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Category not found.' });
        }
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.deleteCategoriesByExport = async (req, res) => {
    try {
        const { exportId } = req.params;
        const deleted = await categoriesService.deleteCategoriesByExportId(exportId);
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
