const mongoose = require('mongoose');

// One document per custom field an admin has defined for THEIR business.
// E.g. a tour operator might define "Package Type" (select) and
// "Travel Date" (date); a bank might define "Loan Amount" (number) and
// "Branch" (text). Every Lead in that tenant can then store a value for
// each active field under Lead.customFields, keyed by `key`.
const customFieldDefinitionSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    required: true,
    index: true,
  },

  // Human-editable display name shown on the form/detail screen.
  // Can be renamed freely without breaking existing saved data, because
  // saved values are keyed by `key`, not by `label`.
  label: { type: String, required: true, trim: true, maxlength: 60 },

  // Stable machine key, derived from the label at creation time
  // (slugified) and never changed afterwards — this is what
  // Lead.customFields is actually keyed by. Unique per tenant so two
  // fields in the same business can't collide, but two different
  // tenants can both have a field with the same key (e.g. both could
  // have "notes" or "package_type") without conflict.
  key: { type: String, required: true, trim: true, maxlength: 60 },

  type: {
    type: String,
    enum: ['text', 'number', 'select', 'date'],
    required: true,
  },

  // Only meaningful when type === 'select'. Plain strings, shown in the
  // given order as dropdown choices.
  options: {
    type: [String],
    default: [],
  },

  required: { type: Boolean, default: false },

  // Controls display order on the lead form/detail screen. Lower first.
  order: { type: Number, default: 0 },

  // Soft "delete" — an admin removing a field doesn't erase already-saved
  // lead data for it (that would silently destroy history). Inactive
  // fields just stop appearing on the create/edit form; existing leads
  // still show whatever value they already had for it on the detail
  // screen labelled from this same definition.
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// A tenant can't define the same key twice (label can repeat, key can't —
// this is what addCustomField slugifies + de-dupes against).
customFieldDefinitionSchema.index({ tenantId: 1, key: 1 }, { unique: true });
customFieldDefinitionSchema.index({ tenantId: 1, isActive: 1, order: 1 });

module.exports = mongoose.model('CustomFieldDefinition', customFieldDefinitionSchema);
