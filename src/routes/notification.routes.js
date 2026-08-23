const router = require('express').Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const ctrl = require('../controllers/notification.controller');

// Sab routes ke liye login zaroori
router.use(auth);

// Current user ki notifications
router.get('/', ctrl.getMyNotifications);
router.get('/unread-count', ctrl.getUnreadCount);
router.patch('/read-all', ctrl.markAllRead);
router.patch('/:id/read', ctrl.markAsRead);
router.delete('/:id', ctrl.deleteNotification);

// Admin only: notification bhejna
router.post('/send', adminOnly, ctrl.sendNotification);

module.exports = router;
