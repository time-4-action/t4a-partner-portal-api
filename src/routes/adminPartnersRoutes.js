const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminPartnersController');

// NOTE: `/overview` MUST be declared before `/:sub` so it is not swallowed by the
// param route. `:sub` is an Auth0 sub (e.g. "auth0|123"), URL-encoded by the caller.

router.get('/overview', controller.overview);

router.get('/:sub', controller.detail);
router.get('/:sub/activity', controller.activity);

router.get('/:sub/notes', controller.listNotes);
router.post('/:sub/notes', controller.addNote);
router.delete('/:sub/notes/:noteId', controller.deleteNote);

module.exports = router;
