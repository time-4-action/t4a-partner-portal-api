const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const detectApiKey = require('../middleware/detectApiKey');

// Flag requests that carry a valid x-api-key so read handlers can widen
// results to unpublished / inactive products (anonymous callers stay
// published-only). Non-blocking — never rejects.
router.use(detectApiKey);

router.get('/search', productController.searchProducts);
router.get('/', productController.getAllProducts);
router.get('/tsv/:exportId', productController.getProductsAsTsv);
router.get('/with-ai-categories', productController.getProductsWithAiCategories);
router.put('/:id/ai-category', productController.setProductAiCategory);
router.delete('/:id/ai-category/:exportId', productController.removeProductAiCategory);
router.delete('/ai-categories/export/:exportId', productController.clearAiCategoriesForExport);
router.get('/:code', productController.getProductByIdentifier);

module.exports = router;