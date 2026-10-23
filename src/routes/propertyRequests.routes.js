const router = require('express').Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const ctrl = require('../controllers/propertyRequests.controller');

// Protect MongoDB reads and updates with the existing authenticated admin access.
router.use(auth, adminOnly);
router.get('/', ctrl.listPropertyRequests);
router.patch('/:requestId/complete', ctrl.completePropertyRequest);

module.exports = router;
