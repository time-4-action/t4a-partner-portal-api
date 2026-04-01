const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');

router.get('/', productController.getAllProducts);
router.get('/tsv/:exportId', productController.getProductsAsTsv);
router.get('/with-ai-categories', productController.getProductsWithAiCategories);
router.put('/:id/ai-category', productController.setProductAiCategory);
router.delete('/:id/ai-category/:exportId', productController.removeProductAiCategory);
router.delete('/ai-categories/export/:exportId', productController.clearAiCategoriesForExport);
router.get('/:code', productController.getProductByIdentifier);

module.exports = router;