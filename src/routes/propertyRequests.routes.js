const router = require('express').Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const ctrl = require('../controllers/propertyRequests.controller');

router.use(auth, adminOnly);
router.get('/', ctrl.listPropertyRequests);
router.patch('/:requestId', ctrl.updatePropertyRequest);
router.patch('/:requestId/complete', ctrl.completePropertyRequest); // backward compat
module.exports = router;
