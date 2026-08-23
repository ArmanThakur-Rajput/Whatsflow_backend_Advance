const router = require('express').Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const ctrl = require('../controllers/schedule.controller');

router.use(auth);

// Anyone authenticated (admin or employee) can view the schedule / slots —
// employees need this to know when the admin is free before booking.
router.get('/', ctrl.getSchedule);
router.get('/slots', ctrl.getAvailableSlots);

// Only admin can edit their own schedule.
router.put('/', adminOnly, ctrl.updateSchedule);

module.exports = router;