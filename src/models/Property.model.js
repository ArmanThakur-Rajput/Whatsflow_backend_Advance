const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },

  // Property Details
  projectName: { type: String, required: true, trim: true },
  intent: { type: String, enum: ['rent', 'buy'], required: true },
  propertyType: { type: String, required: true, trim: true }, // from master data
  flatConfig: { type: String, trim: true }, // 1RK, 1BHK, 2BHK etc — only for Flat
  carpetArea: { type: String, trim: true },
  buildupArea: { type: String, trim: true },
  plotArea: { type: String, trim: true }, // only for Plot
  location: { type: String, required: true, trim: true }, // from master data
  address: { type: String, trim: true },
  price: { type: String, trim: true },
  amenities: [{ type: String, trim: true }], // from master data
  parking: { type: String, trim: true }, // from master data
  notes: { type: String, trim: true },

  // Owner Details (optional)
  ownerName: { type: String, trim: true },
  ownerPhone: { type: String, trim: true },

  // Photos — stored as Cloudflare R2 URLs
  photos: [{ type: String }],

  // Status
  status: { type: String, enum: ['available', 'sold', 'rented'], default: 'available' },
  soldOrRentedAt: { type: Date },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

propertySchema.index({ tenantId: 1, status: 1 });
propertySchema.index({ tenantId: 1, location: 1 });
propertySchema.index({ tenantId: 1, propertyType: 1 });
propertySchema.index({ tenantId: 1, flatConfig: 1 });

module.exports = mongoose.model('Property', propertySchema);
