const Notification = require('../models/Notification.model');
const User = require('../models/User.model');
const asyncHandler = require('../utils/asyncHandler');
const sendPushNotification = require('../utils/sendPushNotification');

const VALID_TYPES = ['info', 'success', 'warning', 'alert'];

// --- ADMIN: Send notification to one user OR all users ---
exports.sendNotification = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const { title, message, target } = req.body;
  let { type } = req.body;

  if (!title || !message) {
    return res.status(400).json({ message: 'Title and message are required' });
  }
  if (!target) {
    return res.status(400).json({ message: 'Target is required (all or a user id)' });
  }
  if (type && !VALID_TYPES.includes(type)) type = 'info';

  if (target === 'all') {
    const users = await User.find({ tenantId, isActive: true, _id: { $ne: req.user._id } })
      .select('_id pushTokens');

    if (!users.length) {
      return res.status(400).json({ message: 'No recipients found' });
    }

    const docs = users.map((u) => ({
      tenantId,
      user: u._id,
      title: title.trim(),
      message: message.trim(),
      type: type || 'info',
      createdBy: req.user._id,
      broadcast: true,
    }));
    await Notification.insertMany(docs);

    await Promise.allSettled(
      users
        .filter((u) => u.pushTokens?.length)
        .map((u) => u.pushTokens.map(t => sendPushNotification(t, title.trim(), message.trim()))).flat()
    );

    return res.status(201).json({
      message: `Notification sent to ${docs.length} user(s)`,
      count: docs.length,
    });
  }

  // Single user — scoped to this tenant so an admin can't send (or even
  // probe for the existence of) a user belonging to a different business.
  const recipient = await User.findOne({ _id: target, tenantId }).select('_id isActive pushTokens');
  if (!recipient) {
    return res.status(404).json({ message: 'User not found' });
  }

  await Notification.create({
    tenantId,
    user: recipient._id,
    title: title.trim(),
    message: message.trim(),
    type: type || 'info',
    createdBy: req.user._id,
    broadcast: false,
  });

  if (recipient.pushTokens?.length) {
    await Promise.allSettled(recipient.pushTokens.map(t => sendPushNotification(t, title.trim(), message.trim())));
  }

  res.status(201).json({ message: 'Notification sent', count: 1 });
});

// --- Current user ki notifications ---
// FIX #2: All read/write queries now include tenantId in addition to
// user._id. Filtering only by user._id allowed a user who guessed
// another user's ObjectId to read or delete cross-tenant notifications.
exports.getMyNotifications = asyncHandler(async (req, res) => {
  const { _id: userId, tenantId } = req.user;

  const notifications = await Notification.find({ user: userId, tenantId })
    .sort({ createdAt: -1 })
    .limit(100);

  const unreadCount = await Notification.countDocuments({
    user: userId,
    tenantId,
    isRead: false,
  });

  res.json({ notifications, unreadCount });
});

// --- Sirf unread count ---
exports.getUnreadCount = asyncHandler(async (req, res) => {
  const { _id: userId, tenantId } = req.user;

  const unreadCount = await Notification.countDocuments({
    user: userId,
    tenantId,
    isRead: false,
  });
  res.json({ unreadCount });
});

// --- Ek notification ko read mark karo ---
exports.markAsRead = asyncHandler(async (req, res) => {
  const { _id: userId, tenantId } = req.user;

  const notif = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: userId, tenantId },
    { isRead: true },
    { new: true }
  );
  if (!notif) {
    return res.status(404).json({ message: 'Notification not found' });
  }
  res.json({ message: 'Marked as read', notification: notif });
});

// --- Saari read mark karo ---
exports.markAllRead = asyncHandler(async (req, res) => {
  const { _id: userId, tenantId } = req.user;

  await Notification.updateMany(
    { user: userId, tenantId, isRead: false },
    { isRead: true }
  );
  res.json({ message: 'All notifications marked as read' });
});

// --- Ek notification delete karo ---
exports.deleteNotification = asyncHandler(async (req, res) => {
  const { _id: userId, tenantId } = req.user;

  const notif = await Notification.findOneAndDelete({
    _id: req.params.id,
    user: userId,
    tenantId,
  });
  if (!notif) {
    return res.status(404).json({ message: 'Notification not found' });
  }
  res.json({ message: 'Notification deleted' });
});
