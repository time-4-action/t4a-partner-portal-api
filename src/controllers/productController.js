const productService = require('../services/product.service');

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