const mongoose = require('mongoose');

const noteSchema = new mongoose.Schema({
  content: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const timelineSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['created', 'status_changed', 'note_added',
      'followup_added', 'assigned', 'appointment_set', 'visit_update'],
  },
  description: String,
}, { timestamps: true });

const leadSchema = new mongoose.Schema({
  // Every lead belongs to exactly one Account (tenant). Required so a
  // lead can never accidentally exist without a tenant scope.
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    required: true,
    index: true,
  },

  name: { type: String, required: true, trim: true },

  // PRIMARY phone — must be exactly 10 digits. Previously unique
  // globally across the whole collection, which meant two different
  // businesses (tenants) could never both have a lead with the same
  // phone number — a real customer's number colliding across two
  // unrelated businesses is completely normal and must be allowed.
  // Uniqueness is now enforced per-tenant via the compound index below
  // instead of a field-level `unique: true`.
  phone: {
    type: String,
    required: true,
    trim: true,
    match: [/^\d{10}$/, 'Phone must be exactly 10 digits'],
  },

  secondaryPhone: { type: String, default: '', trim: true },
  email: { type: String, trim: true },
  city: { type: String, trim: true },
  source: { type: String, default: 'Unknown' },
  campaign: { type: String },
  message: { type: String },
  car: { type: String },

  // Visitor date — scheduled date when the customer will visit the
  // showroom/office. Stored as a formatted string (e.g. "15 Jun 2025")
  // since it's set from a date-picker and displayed as-is.
  visitorDate: { type: String, default: '' },

  // Visitor time — optional time of visit (e.g. "10:30 AM").
  // Stored as a formatted string, set alongside visitorDate.
  visitorTime: { type: String, default: '' },

  // ── Visit lifecycle ──────────────────────────────────────────────────
  // Stored: 'upcoming' (default) | 'completed' | 'cancelled'.
  // "Awaiting update" is NOT stored — it is derived at read time
  // (visitStatus === 'upcoming' AND visit date/time has already passed),
  // so the UI is always correct even if a cron hasn't fired yet.
  // Old leads that have no visitStatus field are treated as 'upcoming'.
  visitStatus: {
    type: String,
    enum: ['upcoming', 'completed', 'cancelled'],
    default: 'upcoming',
  },

  // true once the "did the visit happen?" notification has been sent for
  // the CURRENT visit slot. Reset to false on schedule / reschedule.
  visitPromptSent: { type: Boolean, default: false },

  // Final outcome of the current visit (cleared whenever a new visit is
  // scheduled). completed -> details, cancelled -> cancelReason.
  visitOutcome: {
    details:      { type: String, default: '' },
    cancelReason: { type: String, default: '' },
    closedAt:     { type: Date, default: null },
    closedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },

  // Append-only audit trail of every visit action on this lead
  // (scheduled / rescheduled / completed / cancelled).
  visitHistory: [{
    action:   { type: String, enum: ['scheduled', 'rescheduled', 'completed', 'cancelled'] },
    date:     { type: String, default: '' },   // visit date after this action
    time:     { type: String, default: '' },
    prevDate: { type: String, default: '' },   // only for 'rescheduled'
    prevTime: { type: String, default: '' },
    note:     { type: String, default: '' },   // details / reason
    by:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName:   { type: String, default: '' },
    at:       { type: Date, default: Date.now },
  }],

  // Admin-defined dynamic fields for this tenant's business (e.g. a
  // tour operator might define "Package Type" / "Travel Date"; a bank
  // might define "Loan Amount" / "Branch"). Keyed by the field
  // definition's stable `key` (see CustomFieldDefinition.model.js),
  // not by its human-editable label, so renaming a field's label never
  // orphans already-saved data. Values are validated against the
  // tenant's active field definitions in the controller before save —
  // this schema intentionally stays loose (Mixed) since field types
  // (text/number/select/date) determine the expected shape, not Mongoose.
  customFields: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: () => new Map(),
  },

  status: {
    type: String,
    enum: ['New', 'Interested', 'Contacted', 'Not Interested', 'Pending', 'Booked', 'Deleted'],
    default: 'New',
  },

  // Bumped only on creation and explicit status change (see updateStatus in
  // lead.controller.js) — NOT on every save. Drives the "moves to top of
  // its filter" ordering, kept separate from `updatedAt` (which also
  // changes on pin/unpin, notes, follow-ups, assignment, etc. — none of
  // which should reorder the list).
  statusUpdatedAt: { type: Date, default: Date.now },

  // Soft-delete fields
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  statusBeforeDelete: { type: String, default: null },

  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isPinned: { type: Boolean, default: false },
  notes: [noteSchema],
  timeline: [timelineSchema],
}, { timestamps: true });

// Indexes
// Phone uniqueness is now scoped to a tenant — the SAME phone number can
// exist in two different tenants' lead collections (two unrelated
// businesses serving the same real person), but never twice within one
// tenant. secondaryPhone intentionally has no uniqueness constraint,
// same as before — only the duplicate-check logic in the controller
// guards against secondary-phone collisions.
leadSchema.index({ tenantId: 1, phone: 1 }, { unique: true });
leadSchema.index({ tenantId: 1, secondaryPhone: 1 }, { sparse: true });
leadSchema.index({ tenantId: 1, assignedTo: 1, createdAt: -1 });
leadSchema.index({ tenantId: 1, assignedTo: 1, status: 1 });
leadSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });
leadSchema.index({ tenantId: 1, assignedTo: 1, statusUpdatedAt: -1 });
leadSchema.index({ tenantId: 1, createdAt: -1 });
// Visitors screen / cron: leads of a tenant that have a visit date
leadSchema.index({ tenantId: 1, visitorDate: 1, visitStatus: 1 });

// ─── Auto-assign hook ────────────────────────────────────────────────────────
// Runs AFTER a brand-new lead is saved (isNew = true).
// If assignedTo is already set (admin manually assigned), skip.
leadSchema.post('save', async function (doc) {
  if (!doc.wasNew) return;           // only on first insert
  if (doc.assignedTo) return;        // already manually assigned

  try {
    const { getNextEmployee } = require('../utils/autoAssign');
    // Scoped to this lead's own tenant — round-robin must only ever
    // pick an employee belonging to the SAME business as the lead,
    // never an employee from a different tenant.
    const employeeId = await getNextEmployee(doc.tenantId);
    if (!employeeId) return;         // no active employees — leave unassigned

    await doc.constructor.findByIdAndUpdate(doc._id, {
      assignedTo: employeeId,
      $push: {
        timeline: {
          type: 'assigned',
          description: 'Auto-assigned via round-robin',
        },
      },
    });
  } catch (err) {
    // Never crash the main flow because of assignment failure
    console.error('[AutoAssign] Error:', err.message);
  }
});

// We need to know if this was a new document inside post('save'),
// but `this.isNew` is already false by then. So we store it in pre('save').
leadSchema.pre('save', function (next) {
  this.wasNew = this.isNew;
  next();
});

module.exports = mongoose.model('Lead', leadSchema);