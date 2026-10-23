/**
 * Daily reminders for unresolved property requests stored in MongoDB's
 * `request_notif` collection.
 *
 * Rules:
 * - Query pending requests globally: intentionally no tenantId/orgId filter.
 * - Notify every active admin until the request is marked complete.
 * - One reminder per request/admin per calendar day (IST), including when
 *   the server restarts and the cron runs again.
 */
const cron = require('node-cron');
const mongoose = require('mongoose');
const User = require('../models/User.model');
const Notification = require('../models/Notification.model');
const sendPushNotification = require('./sendPushNotification');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function startOfTodayIST() {
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate()
  ) - IST_OFFSET_MS);
}

function requestLabel(request) {
  return request.propertyName ||
    request.propertyTitle ||
    request.title ||
    request.name ||
    request.requestType ||
    'Property request';
}

async function sendDailyPendingPropertyRequestNotifications() {
  if (mongoose.connection.readyState !== 1) {
    console.warn('[PropertyRequestNotifier] Database not connected; skipping run');
    return;
  }

  const requests = await mongoose.connection.db
    .collection('request_notif')
    .find({ status: { $regex: /^pending$/i } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(1000)
    .toArray();

  if (!requests.length) {
    console.log('[PropertyRequestNotifier] No pending property requests');
    return;
  }

  // Deliberately global: request matching above does not filter by tenant/org.
  const admins = await User.find({ role: 'admin', isActive: true })
    .select('_id tenantId pushTokens name')
    .lean();

  if (!admins.length) {
    console.log('[PropertyRequestNotifier] No active admins to notify');
    return;
  }

  const dayStart = startOfTodayIST();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  let sent = 0;

  for (const request of requests) {
    const requestId = String(request.requestId || request._id);
    const label = requestLabel(request);
    const title = 'Pending Property Request';
    const message = `"${label}" is still pending. Mark it complete from the property requests screen when finished.`;
    const requestData = {
      type: 'property_request_pending_daily',
      requestId,
    };

    for (const admin of admins) {
      // Notification model requires tenantId for each recipient's own inbox.
      // This is only used to store the notification, not to filter requests.
      if (!admin.tenantId) continue;

      const alreadySentToday = await Notification.exists({
        user: admin._id,
        tenantId: admin.tenantId,
        createdAt: { $gte: dayStart, $lt: dayEnd },
        'data.type': 'property_request_pending_daily',
        'data.requestId': requestId,
      });
      if (alreadySentToday) continue;

      await Notification.create({
        tenantId: admin.tenantId,
        user: admin._id,
        title,
        message,
        type: 'warning',
        broadcast: false,
        data: requestData,
      });

      if (admin.pushTokens?.length) {
        await Promise.allSettled(
          admin.pushTokens.map((token) =>
            sendPushNotification(token, title, message, requestData)
          )
        );
      }
      sent += 1;
    }
  }

  console.log(
    `[PropertyRequestNotifier] Daily reminders created: ${sent}; ` +
    `pending requests: ${requests.length}; active admins: ${admins.length}`
  );
}

function startPropertyRequestNotifier() {
  // 09:00 AM India time = 03:30 UTC.
  cron.schedule('30 3 * * *', async () => {
    try {
      await sendDailyPendingPropertyRequestNotifications();
    } catch (err) {
      console.error('[PropertyRequestNotifier] Daily reminder failed:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log('[PropertyRequestNotifier] Daily 9 AM IST pending-request reminder registered');
}

module.exports = {
  startPropertyRequestNotifier,
  sendDailyPendingPropertyRequestNotifications,
};
