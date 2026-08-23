const mongoose = require('mongoose');

// One sub-document per day of week (0=Sunday ... 6=Saturday), following
// JS Date.getDay() convention so frontend/backend stay consistent without
// translation.
const dayScheduleSchema = new mongoose.Schema({
  dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
  isWorking: { type: Boolean, default: false },
  startTime: { type: String, default: '09:00' },   // "HH:MM", 24h
  endTime: { type: String, default: '18:00' },      // "HH:MM", 24h
  breakStart: { type: String, default: '' },        // "" = no break
  breakEnd: { type: String, default: '' },
  slotDuration: { type: Number, default: 30 },       // minutes
}, { _id: false });

const adminScheduleSchema = new mongoose.Schema({
  // Previously this app intentionally had exactly ONE shared weekly
  // schedule total, regardless of how many admin accounts existed
  // (see the old comments in schedule.controller.js). For multi-tenant
  // support each tenant now needs its OWN independent schedule —
  // tenantId is what schedule.controller.js filters/upserts by now,
  // instead of relying on "whichever single document already exists".
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    required: true,
    unique: true,
    index: true,
  },
  admin: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  days: {
    type: [dayScheduleSchema],
    default: () => Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek })),
  },
}, { timestamps: true });

module.exports = mongoose.model('AdminSchedule', adminScheduleSchema);