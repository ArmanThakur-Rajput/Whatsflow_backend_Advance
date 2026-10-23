const mongoose = require('mongoose');

// Master data for property dropdowns: locations, amenities, parking, property types
const propertyMasterDataSchema = new mongoose.Schema({
  // Single-business app; tenantId retained only for compatibility with legacy documents.
  tenantId: { type: String, index: false },
  category: {
    type: String,
    enum: ['location', 'amenity', 'parking', 'propertyType'],
    required: true,
  },
  value: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// Keep legacy tenant-based indexes in the database compatible; app queries are no longer tenant-filtered.

module.exports = mongoose.model('PropertyMasterData', propertyMasterDataSchema);
