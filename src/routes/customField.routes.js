const router = require('express').Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const ctrl = require('../controllers/customField.controller');

// Every route here requires login, but NOT admin-only — employees need
// read access too, since they fill in these same custom fields when
// creating/editing a lead. Write operations are individually gated
// below with adminOnly.
router.use(auth);

router.get('/', ctrl.getCustomFields);

router.post('/', adminOnly, ctrl.createCustomField);
router.patch('/:id', adminOnly, ctrl.updateCustomField);
router.delete('/:id', adminOnly, ctrl.deleteCustomField);
router.patch('/:id/reactivate', adminOnly, ctrl.reactivateCustomField);

module.exports = router;
