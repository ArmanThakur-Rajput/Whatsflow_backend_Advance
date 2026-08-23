const mongoose = require('mongoose');

// An Account is one customer business using this app — e.g. one
// tour-and-travel company, one bank branch, one real-estate agency.
// Every User (admin + their employees), Lead, Appointment, schedule,
// notification, and custom-field definition belongs to exactly one
// Account via a `tenantId` field that references this model's _id.
//
// Kept deliberately small for now. businessType is freeform (not an
// enum) since this app is meant to work for ANY kind of business, not
// a fixed list we'd have to keep expanding.
const accountSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  businessType: { type: String, trim: true, default: '' },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Account', accountSchema);
