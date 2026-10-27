const Property = require('../models/Property.model');
const PropertyMasterData = require('../models/PropertyMasterData.model');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

// ─── Cloudflare R2 client ──────────────────────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const R2_BUCKET = process.env.R2_BUCKET || 'whatsflow-properties';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, ''); // strip trailing slash

// ─── Helper: upload file buffer to R2 ────────────────────────────────────────
async function uploadBufferToR2(file) {
  const ext = (file.mimetype.split('/')[1] || 'jpg').split('+')[0];
  const key = `properties/${crypto.randomUUID()}.${ext}`;
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

// ─── DELETE image from R2 ──────────────────────────────────────────────────────
async function deleteImageFromR2(url) {
  try {
    // Strip base URL — handle both trailing-slash variants safely
    let key = url;
    if (R2_PUBLIC_URL && url.startsWith(R2_PUBLIC_URL)) {
      key = url.slice(R2_PUBLIC_URL.length).replace(/^\//, '');
    }
    if (!key || key === url) {
      // Fallback: extract path after the domain
      const parsed = new URL(url);
      key = parsed.pathname.replace(/^\//, '');
    }
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (e) {
    console.warn('R2 delete failed:', e.message);
  }
}

// ─── MASTER DATA ──────────────────────────────────────────────────────────────

exports.getMasterData = async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { isActive: true };
    if (category) filter.category = category;
    const items = await PropertyMasterData.find(filter).sort({ value: 1 }).lean();
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.addMasterData = async (req, res) => {
  try {
    const { category, value } = req.body;
    if (!category || !value) return res.status(400).json({ success: false, message: 'category and value required' });
    const item = await PropertyMasterData.findOneAndUpdate(
      { category, value },
      { isActive: true },
      { upsert: true, new: true }
    );
    res.status(201).json({ success: true, item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteMasterData = async (req, res) => {
  try {
    await PropertyMasterData.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────

exports.getStats = async (req, res) => {
  try {
    const [total, available, sold] = await Promise.all([
      Property.countDocuments({}),
      Property.countDocuments({ status: 'available' }),
      Property.countDocuments({ status: { $in: ['sold', 'rented'] } }),
    ]);
    res.json({ success: true, total, available, sold });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── EXPLORE ──────────────────────────────────────────────────────────────────

exports.getLocationsSummary = async (req, res) => {
  try {
    const agg = await Property.aggregate([
      { $match: {} },
      { $group: {
        _id: '$location',
        total: { $sum: 1 },
        available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } },
        sold:      { $sum: { $cond: [{ $in: ['$status', ['sold']] }, 1, 0] } },
        rented:    { $sum: { $cond: [{ $in: ['$status', ['rented']] }, 1, 0] } },
      }},
      { $sort: { total: -1 } },
    ]);
    res.json({ success: true, locations: agg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getTypesSummary = async (req, res) => {
  try {
    const filter = {};
    if (req.query.location) filter.location = req.query.location;
    const agg = await Property.aggregate([
      { $match: filter },
      { $group: {
        _id: '$propertyType',
        total: { $sum: 1 },
        available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } },
        sold:      { $sum: { $cond: [{ $in: ['$status', ['sold']] }, 1, 0] } },
        rented:    { $sum: { $cond: [{ $in: ['$status', ['rented']] }, 1, 0] } },
      }},
      { $sort: { total: -1 } },
    ]);
    res.json({ success: true, types: agg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PROPERTIES CRUD ──────────────────────────────────────────────────────────

exports.getProperties = async (req, res) => {
  try {
    const filter = {};
    if (req.query.location) filter.location = req.query.location;
    if (req.query.propertyType) filter.propertyType = req.query.propertyType;
    if (req.query.flatConfig) filter.flatConfig = req.query.flatConfig;
    if (req.query.status) filter.status = req.query.status;
    const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();
    const normalizedProperties = properties.map((p) => ({
      ...p,
      projectName: p.projectName || p.society || '',
      status: p.status === 'complete' || !p.status ? 'available' : p.status,
      flatConfig: p.flatConfig || p.bhk || '',
    }));
    res.json({ success: true, properties: normalizedProperties });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getPropertyById = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id).lean();
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });
    const normalizedProperty = {
      ...property,
      projectName: property.projectName || property.society || '',
      status: property.status === 'complete' || !property.status ? 'available' : property.status,
      flatConfig: property.flatConfig || property.bhk || '',
    };
    res.json({ success: true, property: normalizedProperty });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.createProperty = async (req, res) => {
  try {
    const {
      projectName, intent, propertyType, flatConfig, carpetArea, buildupArea,
      plotArea, buildingArea, totalFloors, flatsOnFloor, lift, wings, facing,
      location, address, price, sanction, parking, water, floor,
      amenities, notes, ownerName, ownerPhone, tenantPhone, gmapsLink,
      furnishing, maintenance,
      // new fields
      listingType, nearbyLocalities,
      monthlyRent, securityDeposit,
      propertyAge, possession, possessionDate,
      documents,
    } = req.body;
    if (!projectName || !propertyType || !location || !price || !sanction || !parking || !water || !floor) {
      return res.status(400).json({ success: false, message: 'projectName, propertyType, location, price, sanction, parking, water, floor are required' });
    }
    const property = await Property.create({
      projectName, intent: intent || 'buy', propertyType, flatConfig,
      carpetArea, buildupArea, plotArea, buildingArea, totalFloors, flatsOnFloor,
      lift, wings, facing,
      location, address, price, sanction, parking, water, floor,
      amenities: amenities || [], notes, ownerName, ownerPhone, tenantPhone, gmapsLink,
      furnishing, maintenance,
      listingType: listingType || 'Sale',
      nearbyLocalities, monthlyRent, securityDeposit,
      propertyAge, possession, possessionDate,
      documents: documents || [],
      createdBy: req.user._id,
    });
    res.status(201).json({ success: true, property });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateProperty = async (req, res) => {
  try {
    const property = await Property.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, property });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteProperty = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });
    // Delete all photos from R2 first
    if (property.photos?.length) {
      await Promise.allSettled(property.photos.map(deleteImageFromR2));
    }
    await property.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.setPropertyStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['available', 'sold', 'rented'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const update = { status };
    if (status !== 'available') update.soldOrRentedAt = new Date();
    const property = await Property.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    );
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, property });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/property-crm/properties/:id/photos
exports.uploadPhotos = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });

    const files = req.files;
    if (!files || !files.length) {
      return res.status(400).json({ success: false, message: 'No photos provided' });
    }

    // Upload images to R2, then update ONLY the photos field in MongoDB.
    // Do not call property.save(): it validates every required/enum field on
    // the document and can reject photo uploads when legacy property fields
    // contain values that no longer match the current schema.
    const urls = await Promise.all(files.map((f) => uploadBufferToR2(f)));

    const updatedProperty = await Property.findByIdAndUpdate(
      req.params.id,
      { $push: { photos: { $each: urls } } },
      { new: true, projection: { photos: 1 } }
    );

    if (!updatedProperty) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    res.json({ success: true, photos: updatedProperty.photos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/property-crm/properties/:id/photos
// Body: { url: '...' }
exports.deletePhoto = async (req, res) => {
  try {
    // Support both JSON body and query param as fallback
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, message: 'url is required' });

    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });

    // Only delete from R2 if URL actually exists in this property's photos
    if (!property.photos.includes(url)) {
      return res.status(400).json({ success: false, message: 'Photo not found on this property' });
    }

    await deleteImageFromR2(url);
    property.photos = property.photos.filter((p) => p !== url);
    await property.save();
    res.json({ success: true, photos: property.photos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/property-crm/properties/:id/gallery  (public — no auth)
// POST /api/property-crm/properties/:id/share-link
// Generates (or refreshes) a 24-hour share token and returns the public URL.
exports.createShareLink = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) return res.status(404).json({ success: false, message: 'Property not found' });
    const token = crypto.randomBytes(20).toString('hex');
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hrs
    property.shareToken = token;
    property.shareTokenExpiry = expiry;
    await property.save();
    const BASE = (process.env.BACKEND_URL || process.env.APP_URL || '').replace(/\/$/, '');
    const url = `${BASE}/api/property-crm/share/${token}`;
    res.json({ success: true, url, expiresAt: expiry });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/property-crm/share/:token  — public, no auth, full property details page
// Also keeps backward-compat: GET /api/property-crm/properties/:id/gallery
exports.getGalleryPage = async (req, res) => {
  try {
    let property;
    // Route can be called with token (/share/:token) or legacy id (:id/gallery)
    if (req.params.token) {
      property = await Property.findOne({
        shareToken: req.params.token,
        shareTokenExpiry: { $gt: new Date() },
      });
      if (!property) {
        return res.status(410).send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Expired</title><style>body{margin:0;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;}</style></head><body><div><div style="font-size:52px">⏰</div><h2 style="margin:16px 0 8px">Link Expired</h2><p style="color:#9ca3af">This property link was valid for 24 hours and has expired.<br>Ask the agent to send you a fresh link.</p></div></body></html>`);
      }
    } else {
      property = await Property.findById(req.params.id);
      if (!property) return res.status(404).send('Property not found');
    }

    const p = property.toObject ? property.toObject() : property;
    const photos = (p.photos || []).filter(Boolean);
    const isRent = p.listingType === 'Rent';

    function fmt(n) {
      if (!n) return '';
      const num = parseFloat(String(n).replace(/,/g, ''));
      if (isNaN(num) || num === 0) return n;
      if (num >= 10000000) return `₹${(num/10000000).toFixed(2).replace(/\.?0+$/,'')} Cr`;
      if (num >= 100000) return `₹${(num/100000).toFixed(2).replace(/\.?0+$/,'')} L`;
      return `₹${num.toLocaleString('en-IN')}`;
    }

    function row(icon, label, value) {
      if (!value) return '';
      return `<div class="drow"><span class="dicon">${icon}</span><div><div class="dlabel">${label}</div><div class="dval">${value}</div></div></div>`;
    }

    function chips(arr) {
      if (!arr || !arr.length) return '';
      return arr.map(a => `<span class="chip">${a}</span>`).join('');
    }

    const priceDisplay = isRent
      ? (p.monthlyRent ? `₹${Number(String(p.monthlyRent).replace(/,/g,'') || 0).toLocaleString('en-IN')}/mo` : fmt(p.price))
      : fmt(p.price);

    const statusColor = p.status === 'available' ? '#22c55e' : p.status === 'sold' ? '#ef4444' : '#f59e0b';
    const statusLabel = p.status === 'available' ? 'Available' : p.status === 'sold' ? 'Sold' : 'Rented';

    const photosHTML = photos.length ? `
      <div class="photo-hero" id="hero" onclick="openLb(0)">
        <img id="heroImg" src="${photos[0]}" alt="${p.projectName}" loading="eager">
        <div class="photo-count">📷 ${photos.length} photo${photos.length > 1 ? 's' : ''}</div>
        <div class="hero-overlay">Tap to view all</div>
      </div>
      ${photos.length > 1 ? `<div class="thumb-row">${photos.slice(1,5).map((u,i) => `<div class="thumb" onclick="openLb(${i+1})"><img src="${u}" loading="lazy"><div class="thumb-overlay">${i === 3 && photos.length > 5 ? `+${photos.length-5}` : ''}</div></div>`).join('')}</div>` : ''}
    ` : `<div class="no-photo">🏠<p>No photos yet</p></div>`;

    const lbPhotos = JSON.stringify(photos);

    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src *; style-src 'unsafe-inline'; script-src 'unsafe-inline';");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0a0a0a">
  <title>${p.projectName} — KIN Property</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --gold: #D4AF37;
      --gold2: #F5D76E;
      --dark: #0a0a0a;
      --card: #141414;
      --card2: #1c1c1c;
      --border: rgba(255,255,255,0.08);
      --text: #f1f1f1;
      --muted: #9ca3af;
      --green: #22c55e;
    }
    html { scroll-behavior: smooth; }
    body { background: var(--dark); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; }

    /* ── Brand Header ── */
    .brand-header {
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1200 50%, #0a0a0a 100%);
      border-bottom: 1px solid rgba(212,175,55,0.3);
      padding: 20px 16px 16px;
      text-align: center;
    }
    .brand-logo {
      font-size: 11px; letter-spacing: 4px; text-transform: uppercase;
      color: var(--gold); font-weight: 700; margin-bottom: 4px; opacity: 0.8;
    }
    .brand-name {
      font-size: 26px; font-weight: 900; letter-spacing: 2px;
      background: linear-gradient(135deg, var(--gold) 0%, var(--gold2) 50%, var(--gold) 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .brand-tagline {
      font-size: 11px; color: rgba(212,175,55,0.6); letter-spacing: 1.5px; margin-top: 4px;
    }

    /* ── Photos ── */
    .photo-hero {
      position: relative; width: 100%; aspect-ratio: 4/3; max-height: 300px;
      overflow: hidden; cursor: pointer; background: #111;
    }
    .photo-hero img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.4s; }
    .photo-hero:active img { transform: scale(0.98); }
    .photo-count {
      position: absolute; bottom: 10px; right: 10px;
      background: rgba(0,0,0,0.75); backdrop-filter: blur(8px);
      color: #fff; font-size: 12px; font-weight: 600;
      padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.15);
    }
    .hero-overlay {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0); transition: background 0.2s;
      color: #fff; font-size: 14px; font-weight: 600; opacity: 0;
      transition: opacity 0.2s;
    }
    .photo-hero:hover .hero-overlay { opacity: 1; background: rgba(0,0,0,0.3); }
    .thumb-row {
      display: grid; grid-template-columns: repeat(4,1fr); gap: 2px;
      background: #000; border-top: 2px solid var(--dark);
    }
    .thumb { position: relative; aspect-ratio: 1; overflow: hidden; cursor: pointer; background: #111; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.2s; }
    .thumb:active img { transform: scale(0.95); }
    .thumb-overlay {
      position: absolute; inset: 0; background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 18px; font-weight: 800;
    }
    .no-photo {
      padding: 40px; text-align: center; background: var(--card); color: var(--muted);
      font-size: 32px;
    }
    .no-photo p { font-size: 14px; margin-top: 8px; }

    /* ── Body ── */
    .body { padding: 0 14px 80px; max-width: 640px; margin: 0 auto; }

    /* ── Property Title Block ── */
    .title-block { padding: 20px 0 16px; border-bottom: 1px solid var(--border); }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.3px;
    }
    .badge-status { background: ${statusColor}18; color: ${statusColor}; border: 1px solid ${statusColor}30; }
    .badge-listing { background: rgba(212,175,55,0.12); color: var(--gold); border: 1px solid rgba(212,175,55,0.3); }
    .badge-type { background: rgba(255,255,255,0.06); color: #d1d5db; border: 1px solid var(--border); }
    .prop-title { font-size: 22px; font-weight: 900; color: var(--text); line-height: 1.25; margin-bottom: 6px; }
    .prop-location { color: var(--muted); font-size: 14px; display: flex; align-items: center; gap: 5px; margin-bottom: 14px; }

    /* ── Price Block ── */
    .price-block {
      background: linear-gradient(135deg, #141400 0%, #1c1900 100%);
      border: 1px solid rgba(212,175,55,0.2);
      border-radius: 14px; padding: 16px; margin: 16px 0;
    }
    .price-label { font-size: 11px; color: rgba(212,175,55,0.7); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .price-value { font-size: 28px; font-weight: 900; color: var(--gold); line-height: 1; }
    .price-sub { font-size: 12px; color: var(--muted); margin-top: 6px; }
    .price-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
    .price-item { background: rgba(255,255,255,0.05); border-radius: 10px; padding: 8px 12px; flex: 1; min-width: 120px; }
    .price-item-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .price-item-val { font-size: 15px; font-weight: 700; color: var(--text); margin-top: 2px; }

    /* ── Section ── */
    .section { margin: 20px 0; }
    .section-title {
      font-size: 11px; color: var(--gold); text-transform: uppercase; letter-spacing: 2px;
      font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;
    }
    .section-title::after { content: ''; flex: 1; height: 1px; background: rgba(212,175,55,0.2); }

    /* ── Detail Rows ── */
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    @media(max-width: 360px) { .detail-grid { grid-template-columns: 1fr; } }
    .drow {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 12px; padding: 12px 14px;
      display: flex; align-items: flex-start; gap: 10px;
    }
    .drow.full { grid-column: 1/-1; }
    .dicon { font-size: 18px; margin-top: 1px; flex-shrink: 0; }
    .dlabel { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
    .dval { font-size: 14px; font-weight: 600; color: var(--text); line-height: 1.3; }

    /* ── Chip list ── */
    .chip-list { display: flex; flex-wrap: wrap; gap: 7px; }
    .chip {
      background: rgba(255,255,255,0.06); border: 1px solid var(--border);
      border-radius: 20px; padding: 5px 12px;
      font-size: 12px; color: var(--text); font-weight: 500;
    }
    .chip.gold { background: rgba(212,175,55,0.1); border-color: rgba(212,175,55,0.25); color: var(--gold); }

    /* ── Possession banner ── */
    .possession-banner {
      background: linear-gradient(135deg, rgba(34,197,94,0.1), rgba(34,197,94,0.05));
      border: 1px solid rgba(34,197,94,0.2);
      border-radius: 12px; padding: 14px 16px;
      display: flex; align-items: center; gap: 12px;
    }
    .possession-icon { font-size: 24px; }
    .possession-title { font-size: 13px; font-weight: 700; color: var(--green); }
    .possession-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .possession-uc {
      background: linear-gradient(135deg, rgba(245,158,11,0.1), rgba(245,158,11,0.05));
      border-color: rgba(245,158,11,0.2);
    }
    .possession-uc .possession-title { color: #f59e0b; }

    /* ── Docs ── */
    .doc-item {
      display: flex; align-items: center; gap: 8px;
      background: var(--card); border: 1px solid var(--border);
      border-radius: 10px; padding: 10px 14px;
      font-size: 13px; color: var(--text); font-weight: 500;
    }

    /* ── Footer CTA ── */
    .footer {
      position: fixed; bottom: 0; left: 0; right: 0;
      background: linear-gradient(to top, rgba(10,10,10,1) 70%, transparent);
      padding: 16px 14px 20px;
    }
    .cta-btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      background: linear-gradient(135deg, #25D366, #128C7E);
      color: #fff; font-size: 15px; font-weight: 800;
      border: none; border-radius: 14px; padding: 16px;
      width: 100%; text-decoration: none; cursor: pointer;
      letter-spacing: 0.3px;
    }

    /* ── Expiry notice ── */
    .expiry-bar {
      background: rgba(212,175,55,0.08); border-top: 1px solid rgba(212,175,55,0.15);
      padding: 8px 14px; text-align: center;
      font-size: 11px; color: rgba(212,175,55,0.6);
    }

    /* ── Lightbox ── */
    #lb {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.97); z-index: 999;
      flex-direction: column; align-items: center; justify-content: center;
      touch-action: pan-y;
    }
    #lb.open { display: flex; }
    .lb-bar {
      position: fixed; top: 0; left: 0; right: 0;
      padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
      background: linear-gradient(to bottom, rgba(0,0,0,0.85), transparent); z-index: 10;
    }
    .lb-close {
      width: 38px; height: 38px; border-radius: 50%;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 18px; color: #fff;
    }
    .lb-counter { color: #d1d5db; font-weight: 600; font-size: 14px; }
    #lb-img { max-width: 96vw; max-height: 80vh; object-fit: contain; border-radius: 8px; user-select: none; }
    .lb-nav {
      position: fixed; top: 50%; transform: translateY(-50%);
      width: 42px; height: 42px; border-radius: 50%;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 20px; color: #fff; z-index: 10;
    }
    #lb-prev { left: 8px; } #lb-next { right: 8px; }
  </style>
</head>
<body>
  <!-- Brand Header -->
  <div class="brand-header">
    <div class="brand-logo">Real Estate</div>
    <div class="brand-name">KIN PROPERTY</div>
    <div class="brand-tagline">YOUR PROPERTY, OUR TRUST</div>
  </div>

  <!-- Photos -->
  ${photosHTML}

  <div class="body">
    <!-- Title Block -->
    <div class="title-block">
      <div class="badges">
        <span class="badge badge-status">● ${statusLabel}</span>
        <span class="badge badge-listing">${p.listingType || 'Sale'}</span>
        ${p.propertyType ? `<span class="badge badge-type">${p.propertyType}</span>` : ''}
        ${p.flatConfig ? `<span class="badge badge-type">${p.flatConfig}</span>` : ''}
      </div>
      <div class="prop-title">${p.projectName}</div>
      <div class="prop-location">📍 ${p.location}</div>
      ${p.nearbyLocalities ? `<div style="color:#6b7280;font-size:12px;margin-top:-8px;margin-bottom:8px">Near: ${p.nearbyLocalities}</div>` : ''}
    </div>

    <!-- Price Block -->
    <div class="price-block">
      <div class="price-label">${isRent ? 'Monthly Rent' : 'Sale Price'}</div>
      <div class="price-value">${priceDisplay || '—'}</div>
      ${p.maintenance ? `<div class="price-sub">+ ₹${p.maintenance}/mo maintenance</div>` : ''}
      ${isRent && (p.securityDeposit || p.monthlyRent) ? `
      <div class="price-row">
        ${p.monthlyRent ? `<div class="price-item"><div class="price-item-label">Monthly Rent</div><div class="price-item-val">₹${Number(String(p.monthlyRent).replace(/,/g,'')||0).toLocaleString('en-IN')}</div></div>` : ''}
        ${p.securityDeposit ? `<div class="price-item"><div class="price-item-label">Security Deposit</div><div class="price-item-val">₹${Number(String(p.securityDeposit).replace(/,/g,'')||0).toLocaleString('en-IN')}</div></div>` : ''}
      </div>` : ''}
    </div>

    <!-- Possession -->
    ${p.possession ? `
    <div class="section">
      <div class="${p.possession === 'Ready to Move' ? 'possession-banner' : 'possession-banner possession-uc'}">
        <div class="possession-icon">${p.possession === 'Ready to Move' ? '✅' : '🏗️'}</div>
        <div>
          <div class="possession-title">${p.possession}</div>
          ${p.possessionDate ? `<div class="possession-sub">Expected: ${p.possessionDate}</div>` : ''}
        </div>
      </div>
    </div>` : ''}

    <!-- Key Details -->
    <div class="section">
      <div class="section-title">Property Details</div>
      <div class="detail-grid">
        ${row('🏠', 'Property Type', p.propertyType)}
        ${row('📐', 'Carpet Area', p.carpetArea)}
        ${row('📏', 'Buildup Area', p.buildupArea)}
        ${row('🏢', 'Floor', p.floor)}
        ${row('🏗️', 'Total Floors', p.totalFloors)}
        ${row('🧭', 'Facing', p.facing)}
        ${row('🛗', 'Lift', p.lift)}
        ${row('🚗', 'Parking', p.parking)}
        ${row('💧', 'Water Source', p.water)}
        ${row('✅', 'Sanction', p.sanction)}
        ${row('🏡', 'Furnishing', p.furnishing)}
        ${row('📅', 'Property Age', p.propertyAge)}
        ${p.wings ? row('🏘️', 'Wings', p.wings) : ''}
        ${p.flatsOnFloor ? row('🔢', 'Flats on Floor', p.flatsOnFloor) : ''}
      </div>
    </div>

    <!-- Amenities -->
    ${p.amenities && p.amenities.length ? `
    <div class="section">
      <div class="section-title">Amenities</div>
      <div class="chip-list">
        ${p.amenities.map(a => `<span class="chip gold">✦ ${a}</span>`).join('')}
      </div>
    </div>` : ''}

    <!-- Documents Available -->
    ${p.documents && p.documents.length ? `
    <div class="section">
      <div class="section-title">Documents Available</div>
      <div style="display:flex;flex-direction:column;gap:7px;">
        ${p.documents.map(d => `<div class="doc-item">📄 ${d}</div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Notes -->
    ${p.notes ? `
    <div class="section">
      <div class="section-title">Additional Info</div>
      <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;font-size:14px;color:var(--muted);line-height:1.6;">${p.notes}</div>
    </div>` : ''}

    <!-- Map Link -->
    ${p.gmapsLink ? `
    <div class="section">
      <a href="${p.gmapsLink}" target="_blank" style="display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid rgba(66,133,244,0.3);border-radius:12px;padding:14px 16px;text-decoration:none;color:var(--text);">
        <span style="font-size:22px">🗺️</span>
        <div><div style="font-size:13px;font-weight:700;color:#60a5fa;">View on Google Maps</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">Tap to open in Maps app</div></div>
        <span style="margin-left:auto;color:#60a5fa;">→</span>
      </a>
    </div>` : ''}

  </div><!-- /body -->

  <!-- Footer CTA -->
  <div class="footer">
    ${p.ownerPhone
      ? `<a class="cta-btn" href="https://wa.me/91${p.ownerPhone.replace(/\D/g,'')}?text=${encodeURIComponent(`Hi, I'm interested in the property at ${p.projectName}, ${p.location}. Can you share more details?`)}">
          <span style="font-size:20px">💬</span> Contact on WhatsApp
        </a>`
      : `<div style="text-align:center;color:var(--muted);font-size:13px;">Contact your agent for more info</div>`}
  </div>

  <!-- Expiry bar -->
  ${req.params.token ? `<div class="expiry-bar" style="padding-bottom:80px;">🔗 This link expires in 24 hours</div>` : ''}

  <!-- Lightbox -->
  <div id="lb">
    <div class="lb-bar">
      <div class="lb-close" onclick="closeLb()">✕</div>
      <div class="lb-counter" id="lbCount">1 / ${photos.length}</div>
      <div style="width:38px"></div>
    </div>
    <img id="lb-img" src="" alt="">
    ${photos.length > 1 ? `<div class="lb-nav" id="lb-prev" onclick="navLb(-1)">‹</div><div class="lb-nav" id="lb-next" onclick="navLb(1)">›</div>` : ''}
  </div>

  <script>
    const photos = ${lbPhotos};
    let cur = 0;
    function openLb(i) {
      cur = i; document.getElementById('lb-img').src = photos[i];
      document.getElementById('lbCount').textContent = (i+1) + ' / ' + photos.length;
      document.getElementById('lb').classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeLb() {
      document.getElementById('lb').classList.remove('open');
      document.body.style.overflow = '';
    }
    function navLb(d) {
      cur = (cur + d + photos.length) % photos.length;
      document.getElementById('lb-img').src = photos[cur];
      document.getElementById('lbCount').textContent = (cur+1) + ' / ' + photos.length;
    }
    document.getElementById('lb').addEventListener('click', function(e) {
      if (e.target === this) closeLb();
    });
    // Swipe
    let sx = 0;
    document.getElementById('lb').addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    document.getElementById('lb').addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 50 && photos.length > 1) navLb(dx < 0 ? 1 : -1);
    });
  </script>
</body>
</html>`);
  } catch (err) {
    console.error('[getGalleryPage]', err);
    res.status(500).send('Something went wrong loading this property page.');
  }
};


exports.exportCSV = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.propertyType) filter.propertyType = req.query.propertyType;
    if (req.query.location) filter.location = req.query.location;

    const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();

    const escape = (val) => {
      const str = val == null ? '' : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = [
      'Project Name', 'Type', 'Location', 'Price', 'Floor',
      'Carpet Area', 'Buildup Area', 'Sanction', 'Parking', 'Water',
      'Lift', 'Wings', 'Facing', 'Flats on Floor', 'Building Area',
      'Amenities', 'Status', 'Owner Name', 'Owner Phone', 'Tenant Phone',
      'GMaps Link', 'Notes', 'Created At',
    ];

    const rows = [headers.join(',')];
    properties.forEach((p) => {
      rows.push([
        escape(p.projectName), escape(p.propertyType), escape(p.location),
        escape(p.price), escape(p.floor), escape(p.carpetArea), escape(p.buildupArea),
        escape(p.sanction), escape(p.parking), escape(p.water),
        escape(p.lift), escape(p.wings), escape(p.facing), escape(p.flatsOnFloor),
        escape(p.buildingArea), escape((p.amenities || []).join('; ')),
        escape(p.status), escape(p.ownerName), escape(p.ownerPhone),
        escape(p.tenantPhone), escape(p.gmapsLink), escape(p.notes),
        escape(p.createdAt ? new Date(p.createdAt).toLocaleDateString('en-IN') : ''),
      ].join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="properties.csv"');
    res.send(rows.join('\n'));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
