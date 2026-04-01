const express = require('express');
const router = express.Router();
const categoriesController = require('../controllers/categoriesController');

router.get('/', categoriesController.getAllCategories);
router.get('/by-export/:exportId', categoriesController.getCategoriesByExportId);
router.post('/', categoriesController.createCategory);
router.post('/import', categoriesController.importCategories);
router.put('/:id', categoriesController.updateCategory);
router.delete('/by-export/:exportId', categoriesController.deleteCategoriesByExport);
router.delete('/:id', categoriesController.deleteCategory);

module.exports = router;
