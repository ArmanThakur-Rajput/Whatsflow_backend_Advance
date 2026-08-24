const mongoose = require('mongoose');

// Master data for property dropdowns: locations, amenities, parking, property types
const propertyMasterDataSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  category: {
    type: String,
    enum: ['location', 'amenity', 'parking', 'propertyType'],
    required: true,
  },
  value: { type: String, required: true, trim: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

propertyMasterDataSchema.index({ tenantId: 1, category: 1, isActive: 1 });
propertyMasterDataSchema.index({ tenantId: 1, category: 1, value: 1 }, { unique: true });

module.exports = mongoose.model('PropertyMasterData', propertyMasterDataSchema);
