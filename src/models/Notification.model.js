const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    // Needed so a broadcast ("send to all") only ever reaches users in
    // the SENDING ADMIN'S OWN tenant — without this, broadcasting was
    // reaching every active user across every business in the database.
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    // Jis user ko notification mili hai
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['info', 'success', 'warning', 'alert'],
      default: 'info',
    },
    isRead: { type: Boolean, default: false },
    // Admin jisne bheji
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // true = sabko bheji gayi thi (broadcast)
    broadcast: { type: Boolean, default: false },
    // Optional extra data — e.g. { leadId, type: 'visitor_date_reminder' }
    // Frontend ise click pe navigate karne ke liye use karta hai
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Recent notifications jaldi nikalne ke liye
// FIX B: tenantId added — queries now include tenantId so index must lead with it
notificationSchema.index({ tenantId: 1, user: 1, createdAt: -1 });
// Unread-count / filtered lists by read state
notificationSchema.index({ tenantId: 1, user: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
