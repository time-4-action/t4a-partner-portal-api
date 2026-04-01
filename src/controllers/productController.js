const productService = require('../services/product.service');

exports.getProductsWithAiCategories = async (req, res) => {
    try {
        const { exportId } = req.query;
        if (!exportId) {
            return res.status(400).json({ success: false, message: 'exportId query param is required.' });
        }
        const data = await productService.getProductsWithAiCategoriesForExport(exportId);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.setProductAiCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const { exportId, categoryId, categoryName } = req.body;
        if (!exportId || !categoryId || !categoryName) {
            return res.status(400).json({ success: false, message: 'exportId, categoryId and categoryName are required.' });
        }
        const data = await productService.setProductAiCategory(id, exportId, categoryId, categoryName);
        if (!data) return res.status(404).json({ success: false, message: 'Product not found.' });
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.removeProductAiCategory = async (req, res) => {
    try {
        const { id, exportId } = req.params;
        const data = await productService.removeProductAiCategory(id, exportId);
        if (!data) return res.status(404).json({ success: false, message: 'Product not found.' });
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.clearAiCategoriesForExport = async (req, res) => {
    try {
        const { exportId } = req.params;
        const modified = await productService.clearAllAiCategoriesForExport(exportId);
        res.json({ success: true, modified });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getAllProducts = async (req, res) => {
    try {
        const data = await productService.getAllProducts();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getProductByIdentifier = async (req, res) => {
    try {
        const { code } = req.params;
        const product = await productService.getProductByIdentifier(code);
        if (!product) {
            return res.status(404).json({ success: false, message: `Product with code ${code} not found.` });
        }
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getProductsAsTsv = async (req, res) => {
    try {
        const { exportId } = req.params;
        const tsv = await productService.generateProductsTsv(exportId);

        res.header('Content-Type', 'text/tab-separated-values');
        res.header('Content-Disposition', 'attachment; filename="products.tsv"');
        res.send(tsv);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};