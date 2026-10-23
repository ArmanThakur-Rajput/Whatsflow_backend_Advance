const mongoose = require('mongoose');
const User = require('../models/User.model');
const sendPushNotification = require('../utils/sendPushNotification');
const Notification = require('../models/Notification.model');

function getCollection() {
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('Database is not connected');
    err.status = 503;
    throw err;
  }
  return mongoose.connection.db.collection('request_notif');
}

// GET /api/property-requests?status=pending
exports.listPropertyRequests = async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending').trim().toLowerCase();
    if (!['pending', 'complete', 'completed', 'all'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status filter' });
    }

    const filter = status === 'all' ? {} : { status };
    const documents = await getCollection()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(500)
      .toArray();

    return res.json({
      success: true,
      count: documents.length,
      data: documents.map((doc) => ({
        ...doc,
        _id: String(doc._id),
        id: String(doc._id),
        requestId: doc.requestId || null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/property-requests/:requestId
// Partial edit — any writable field (location, bhk, budget, propertyType, society, status, etc.)
exports.updatePropertyRequest = async (req, res, next) => {
  try {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId || requestId.length > 160) {
      return res.status(400).json({ message: 'Valid requestId is required' });
    }

    // Allowed fields the admin can edit
    const ALLOWED = ['location', 'bhk', 'budget', 'price', 'society',
      'propertyType', 'notes', 'status', 'assignedTo'];
    const update = {};
    for (const key of ALLOWED) {
      if (key in req.body) update[key] = req.body[key];
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    update.updatedAt = new Date();
    update.updatedBy = String(req.user?._id || '');

    // If status being set to complete, record completedAt
    if (update.status === 'complete' || update.status === 'completed') {
      update.status = 'complete';
      update.completedAt = new Date();
      update.completedBy = String(req.user?._id || '');
    }

    const result = await getCollection().updateOne(
      { requestId },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: 'Property request not found' });
    }

    const doc = await getCollection().findOne({ requestId });
    return res.json({
      success: true,
      requestId,
      data: { ...doc, _id: String(doc._id), id: String(doc._id) },
      modified: result.modifiedCount > 0,
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/property-requests/:requestId/complete  (kept for backward compat)
exports.completePropertyRequest = async (req, res, next) => {
  req.body = { status: 'complete' };
  return exports.updatePropertyRequest(req, res, next);
};

// ─── CRON: Daily push reminder for all pending property requests ──────────────
// Called from scheduler.js — sends a push to all admins of each tenant
// that has pending requests. Fires daily at 10:00 AM IST (04:30 UTC).
exports.sendPendingRequestReminders = async () => {
  try {
    const col = getCollection();
    const pending = await col.find({ status: 'pending' }).toArray();
    if (!pending.length) return;

    // Group by tenantId (stored on the request_notif doc, may be absent on older docs)
    const byTenant = {};
    for (const doc of pending) {
      const tid = String(doc.tenantId || doc.tenant || 'unknown');
      if (!byTenant[tid]) byTenant[tid] = [];
      byTenant[tid].push(doc);
    }

    for (const [tenantId, docs] of Object.entries(byTenant)) {
      if (tenantId === 'unknown') continue; // skip legacy docs without tenantId

      // Find all admins of this tenant
      const admins = await User.find({
        tenantId,
        role: 'admin',
        isActive: true,
      }).select('_id pushTokens').lean();

      if (!admins.length) continue;

      const count = docs.length;
      const title = '🏠 Pending Property Requests';
      const body = `${count} property request${count > 1 ? 's' : ''} still pending — please review.`;

      // Save in-app notification + fire push for each admin
      const notifDocs = admins.map((a) => ({
        tenantId,
        user: a._id,
        title,
        message: body,
        type: 'alert',
        broadcast: false,
        data: { screen: 'PropertyRequests', type: 'pending_requests_reminder', count },
      }));

      await Notification.insertMany(notifDocs);

      const tokens = admins.flatMap((a) => a.pushTokens || []).filter(Boolean);
      await Promise.allSettled(
        tokens.map((t) =>
          sendPushNotification(t, title, body, {
            screen: 'PropertyRequests',
            type: 'pending_requests_reminder',
            count: String(count),
          })
        )
      );

      console.log(`[PropertyRequests] Reminded ${admins.length} admin(s) in tenant ${tenantId} — ${count} pending`);
    }
  } catch (err) {
    console.error('[PropertyRequests] sendPendingRequestReminders error:', err.message);
  }
};
