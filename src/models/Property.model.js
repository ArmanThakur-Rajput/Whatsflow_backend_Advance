const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({
  // Single-business app: tenantId is optional for legacy documents only.
  tenantId: { type: String, index: false },
  society: { type: String, trim: true },
  sessionId: { type: String, trim: true },

  // ── Required Fields ───────────────────────────────────────────────
  projectName:   { type: String, required: true, trim: true },       // Society/Project Name
  propertyType:  { type: String, required: true, trim: true },       // Flat | Shop | Plot
  location:      { type: String, required: true, trim: true },
  price:         { type: String, required: true, trim: true },
  carpetArea:    { type: String, trim: true },
  buildupArea:   { type: String, trim: true },
  sanction:      { type: String, enum: ['Yes', 'No'], required: true },
  parking:       { type: String, enum: ['Open', 'Covered', 'None'], required: true },
  water:         { type: String, enum: ['Municipal Corporation', 'Gram Panchayat', 'Tanker', 'Boring'], required: true },
  floor:         { type: String, required: true, trim: true },        // Ground, 1, 2 … 99

  // ── Optional Fields ───────────────────────────────────────────────
  intent:        { type: String, enum: ['rent', 'buy'], default: 'buy' },
  flatConfig:    { type: String, trim: true },                        // 1RK, 1BHK, 2BHK etc
  buildingArea:  { type: String, trim: true },
  flatsOnFloor:  { type: String, trim: true },                        // How many flats on same floor
  lift:          { type: String, enum: ['Yes', 'No', ''], default: '' },
  wings:         { type: String, trim: true },
  facing:        { type: String, trim: true },
  amenities:     [{ type: String, trim: true }],
  plotArea:      { type: String, trim: true },
  address:       { type: String, trim: true },
  notes:         { type: String, trim: true },

  // ── Owner / Tenant Details (optional) ────────────────────────────
  ownerName:     { type: String, trim: true },
  ownerPhone:    { type: String, trim: true },
  tenantPhone:   { type: String, trim: true },
  gmapsLink:     { type: String, trim: true },

  // ── Photos — stored as Cloudflare R2 URLs ─────────────────────────
  photos: [{ type: String }],

  // ── Status ───────────────────────────────────────────────────────
  status: { type: String, enum: ['available', 'sold', 'rented'], default: 'available' },
  soldOrRentedAt: { type: Date },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

propertySchema.index({ status: 1 });
propertySchema.index({ location: 1 });
propertySchema.index({ propertyType: 1 });

module.exports = mongoose.model('Property', propertySchema);
