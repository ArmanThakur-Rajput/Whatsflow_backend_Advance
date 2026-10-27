const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({
  // Single-business app: tenantId is optional for legacy documents only.
  tenantId: { type: String, index: false },
  society: { type: String, trim: true },
  sessionId: { type: String, trim: true },

  // ── Required Fields ───────────────────────────────────────────────
  projectName:   { type: String, required: true, trim: true },
  propertyType:  { type: String, required: true, trim: true },
  location:      { type: String, required: true, trim: true },
  price:         { type: String, required: true, trim: true },
  carpetArea:    { type: String, trim: true },
  buildupArea:   { type: String, trim: true },
  sanction:      { type: String, enum: ['Yes', 'No'], required: true },
  parking:       { type: String, enum: ['Open', 'Covered', 'None'], required: true },
  water:         { type: String, enum: ['Municipal Corporation', 'Gram Panchayat', 'Tanker', 'Boring'], required: true },
  floor:         { type: String, required: true, trim: true },

  // ── Listing Type ──────────────────────────────────────────────────
  listingType:   { type: String, enum: ['Sale', 'Rent', ''], default: 'Sale' }, // Sale | Rent

  // ── Locality ─────────────────────────────────────────────────────
  nearbyLocalities: { type: String, trim: true }, // comma-separated nearby areas

  // ── Rent-specific fields ──────────────────────────────────────────
  monthlyRent:      { type: String, trim: true }, // visible only if listingType=Rent
  securityDeposit:  { type: String, trim: true }, // visible only if listingType=Rent

  // ── Property Age ─────────────────────────────────────────────────
  propertyAge:   { type: String, trim: true }, // e.g. "2 years", "New", "5+ years"

  // ── Possession ───────────────────────────────────────────────────
  possession:    { type: String, enum: ['Ready to Move', 'Under Construction', ''], default: '' },
  possessionDate:{ type: String, trim: true }, // only if Under Construction, free-text date like "Dec 2025"

  // ── Documents ────────────────────────────────────────────────────
  documents:     [{ type: String, trim: true }], // multi-checkbox list of available docs

  // ── Optional Fields ───────────────────────────────────────────────
  intent:        { type: String, enum: ['rent', 'buy'], default: 'buy' },
  flatConfig:    { type: String, trim: true },
  buildingArea:  { type: String, trim: true },
  totalFloors:   { type: String, trim: true },
  flatsOnFloor:  { type: String, trim: true },
  lift:          { type: String, enum: ['Yes', 'No', ''], default: '' },
  wings:         { type: String, trim: true },
  facing:        { type: String, trim: true },
  amenities:     [{ type: String, trim: true }],
  plotArea:      { type: String, trim: true },
  address:       { type: String, trim: true },
  notes:         { type: String, trim: true },

  // ── Furnishing ────────────────────────────────────────────────────
  furnishing:    { type: String, enum: ['Unfurnished', 'Semi-Furnished', 'Full Furnished', ''], default: '' },

  // ── Owner / Tenant Details (optional) ────────────────────────────
  ownerName:     { type: String, trim: true },
  ownerPhone:    { type: String, trim: true },
  tenantPhone:   { type: String, trim: true },
  gmapsLink:     { type: String, trim: true },

  // ── Photos — stored as Cloudflare R2 URLs ─────────────────────────
  photos: [{ type: String }],

  // ── Maintenance ──────────────────────────────────────────────────
  maintenance:   { type: String, trim: true },

  // ── Share link (24-hour token for WhatsApp sharing) ───────────────
  shareToken:    { type: String, index: true },
  shareTokenExpiry: { type: Date },

  // ── Status ───────────────────────────────────────────────────────
  status: { type: String, enum: ['available', 'sold', 'rented'], default: 'available' },
  soldOrRentedAt: { type: Date },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

propertySchema.index({ status: 1 });
propertySchema.index({ location: 1 });
propertySchema.index({ propertyType: 1 });
propertySchema.index({ listingType: 1 });

module.exports = mongoose.model('Property', propertySchema);
