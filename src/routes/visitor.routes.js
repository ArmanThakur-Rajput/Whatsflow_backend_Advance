const router = require('express').Router();
const auth = require('../middleware/auth');
const ctrl = require('../controllers/visit.controller');

// Both admin and employee — the controller scopes employees to their own leads.
router.use(auth);

router.get('/', ctrl.listVisitors);
router.patch('/:id/outcome', ctrl.setVisitOutcome);

module.exports = router;
