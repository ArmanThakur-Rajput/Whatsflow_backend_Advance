const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  // Every appointment belongs to exactly one Account (tenant). Needed
  // so the double-booking check (same date+time) only ever looks within
  // ONE tenant's own appointments — two unrelated businesses booking the
  // same calendar slot is completely normal and must not collide.
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    required: true,
    index: true,
  },

  lead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead',
    required: true,
  },
  appointmentDate: { type: String, required: true }, // e.g. "2024-06-25"
  appointmentTime: { type: String, required: true }, // e.g. "16:00"
  description: { type: String, default: '' },
  // 'scheduled' = default/upcoming. 'completed' = admin ticked it done.
  // 'missed' is settable by admin too, but the app also derives an
  // "overdue" visual state client-side for scheduled appointments whose
  // date/time has passed — that derived state does NOT auto-write here,
  // so a scheduled appointment can show as "Missed" in the UI while still
  // being 'scheduled' in the DB until the admin explicitly marks it.
  status: {
    type: String,
    enum: ['scheduled', 'completed', 'missed'],
    default: 'scheduled',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, { timestamps: true });

// Lead detail screen looks up the appointment for a given lead.
appointmentSchema.index({ lead: 1 });

// createAppointment checks for an existing appointment at the same
// date+time WITHIN THE SAME TENANT to prevent double-booking;
// getAvailableSlots queries by tenantId + date alone to find all taken
// times that day for that tenant. This compound index covers both
// (date-only queries can use the prefix).
appointmentSchema.index({ tenantId: 1, appointmentDate: 1, appointmentTime: 1 });

module.exports = mongoose.model('Appointment', appointmentSchema);