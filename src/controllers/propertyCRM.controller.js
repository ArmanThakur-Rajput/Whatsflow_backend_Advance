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
      --gold: #b9953b;
      --gold2: #e4c979;
      --dark: #f5f6f8;
      --card: #ffffff;
      --card2: #f8f9fb;
      --border: #e5e7eb;
      --text: #172033;
      --muted: #667085;
      --green: #16845b;
      --navy: #101b32;
    }
    html { scroll-behavior: smooth; }
    body { background: var(--dark); color: var(--text); font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; line-height: 1.5; }

    /* Premium brand header */
    .brand-header {
      background: var(--navy);
      border-bottom: 3px solid var(--gold);
      padding: 22px 20px 20px;
      text-align: center;
    }
    .brand-logo { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; color: #d8c17c; font-weight: 700; margin-bottom: 5px; }
    .brand-name {
      font-size: 28px; font-weight: 850; letter-spacing: 2px;
      color: #fff;
    }
    .brand-tagline { font-size: 11px; color: #c7cedb; letter-spacing: 1.5px; margin-top: 5px; }

    /* Gallery */
    .photo-hero {
      position: relative; width: min(1120px, calc(100% - 40px)); aspect-ratio: 16/7; max-height: 500px;
      overflow: hidden; cursor: pointer; background: #e9edf2; margin: 26px auto 0; border-radius: 18px;
      box-shadow: 0 12px 32px rgba(16,27,50,.12);
    }
    .photo-hero img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .4s; }
    .photo-hero:hover img { transform: scale(1.015); }
    .photo-hero:active img { transform: scale(.99); }
    .photo-count { position: absolute; bottom: 14px; right: 14px; background: rgba(16,27,50,.82); color: #fff; font-size: 12px; font-weight: 700; padding: 7px 12px; border-radius: 9px; }
    .hero-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(16,27,50,0); color: #fff; font-size: 14px; font-weight: 700; opacity: 0; transition: all .2s; }
    .photo-hero:hover .hero-overlay { opacity: 1; background: rgba(16,27,50,.22); }
    .thumb-row { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; width: min(1120px, calc(100% - 40px)); margin: 10px auto 0; background: transparent; }
    .thumb { position: relative; aspect-ratio: 16/7; overflow: hidden; cursor: pointer; background: #e9edf2; border-radius: 10px; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s; }
    .thumb:hover img { transform: scale(1.04); }
    .thumb:active img { transform: scale(.98); }
    .thumb-overlay { position: absolute; inset: 0; background: rgba(16,27,50,.5); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 18px; font-weight: 800; }
    .no-photo { width: min(1120px, calc(100% - 40px)); margin: 26px auto 0; padding: 64px 24px; text-align: center; background: #fff; border: 1px dashed #cbd2dc; border-radius: 18px; color: var(--muted); font-size: 32px; }
    .no-photo p { font-size: 14px; margin-top: 8px; }

    /* Main content */
    .body { padding: 0 0 120px; width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
    .title-block { padding: 28px 0 20px; border-bottom: 1px solid var(--border); }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 5px 11px; border-radius: 7px; font-size: 11px; font-weight: 750; letter-spacing: .2px; }
    .badge-status { background: ${statusColor}12; color: ${statusColor}; border: 1px solid ${statusColor}30; }
    .badge-listing { background: #f8f2e3; color: #8b6a19; border: 1px solid #e9d9ad; }
    .badge-type { background: #f0f3f7; color: #465269; border: 1px solid #e1e6ee; }
    .prop-title { font-size: clamp(25px, 3vw, 36px); font-weight: 800; color: var(--navy); line-height: 1.2; margin-bottom: 8px; letter-spacing: -.5px; }
    .prop-location { color: var(--muted); font-size: 15px; display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
    .title-block > div[style] { color: #667085 !important; margin-top: 0 !important; }

    /* Price card */
    .price-block { background: linear-gradient(135deg, #fff 0%, #fbf8ef 100%); border: 1px solid #e8dfc8; border-radius: 16px; padding: 22px 24px; margin: 22px 0; box-shadow: 0 5px 18px rgba(16,27,50,.04); }
    .price-label { font-size: 11px; color: #8b6a19; text-transform: uppercase; letter-spacing: 1.3px; font-weight: 750; margin-bottom: 6px; }
    .price-value { font-size: clamp(30px, 4vw, 38px); font-weight: 850; color: var(--navy); line-height: 1.1; }
    .price-sub { font-size: 12px; color: var(--muted); margin-top: 7px; }
    .price-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; }
    .price-item { background: #fff; border: 1px solid #e8eaf0; border-radius: 10px; padding: 10px 14px; flex: 1; min-width: 140px; }
    .price-item-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
    .price-item-val { font-size: 16px; font-weight: 750; color: var(--text); margin-top: 3px; }

    .section { margin: 28px 0; }
    .section-title { font-size: 12px; color: var(--navy); text-transform: uppercase; letter-spacing: 1.5px; font-weight: 800; margin-bottom: 14px; display: flex; align-items: center; gap: 10px; }
    .section-title::after { content: ''; flex: 1; height: 1px; background: #dfe3ea; }
    .detail-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
    .drow { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 15px 16px; display: flex; align-items: flex-start; gap: 11px; box-shadow: 0 2px 6px rgba(16,27,50,.025); }
    .drow.full { grid-column: 1/-1; }
    .dicon { font-size: 20px; margin-top: 1px; flex-shrink: 0; }
    .dlabel { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .7px; margin-bottom: 4px; font-weight: 700; }
    .dval { font-size: 14px; font-weight: 700; color: var(--text); line-height: 1.35; overflow-wrap: anywhere; }

    .chip-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip { background: #fff; border: 1px solid #e1e6ee; border-radius: 8px; padding: 7px 12px; font-size: 12px; color: #465269; font-weight: 600; }
    .chip.gold { background: #fbf7e9; border-color: #e9d9ad; color: #8b6a19; }
    .possession-banner { background: #edf8f2; border: 1px solid #ccebd9; border-radius: 12px; padding: 16px 18px; display: flex; align-items: center; gap: 12px; }
    .possession-icon { font-size: 24px; }
    .possession-title { font-size: 14px; font-weight: 800; color: #16845b; }
    .possession-sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
    .possession-uc { background: #fff8e9; border-color: #f2dfb2; }
    .possession-uc .possession-title { color: #9a6a08; }
    .doc-item { display: flex; align-items: center; gap: 8px; background: #fff !important; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; font-size: 13px; color: var(--text) !important; font-weight: 600; }

    /* Sticky contact action */
    .footer { position: fixed; bottom: 0; left: 0; right: 0; background: linear-gradient(to top, rgba(245,246,248,1) 72%, rgba(245,246,248,0)); padding: 22px max(20px, calc((100vw - 1120px)/2)) 20px; z-index: 20; }
    .cta-btn { display: flex; align-items: center; justify-content: center; gap: 9px; background: #16845b; color: #fff; font-size: 15px; font-weight: 800; border: none; border-radius: 11px; padding: 16px; width: 100%; max-width: 1120px; margin: 0 auto; text-decoration: none; cursor: pointer; letter-spacing: .2px; box-shadow: 0 6px 18px rgba(22,132,91,.22); }
    .cta-btn:hover { background: #116d4b; }
    .expiry-bar { background: #f9f4e6; border-top: 1px solid #eee2c3; padding: 10px 14px; text-align: center; font-size: 11px; color: #8b6a19; }

    /* Photo lightbox */
    #lb { display: none; position: fixed; inset: 0; background: rgba(8,14,27,.97); z-index: 999; flex-direction: column; align-items: center; justify-content: center; touch-action: pan-y; }
    #lb.open { display: flex; }
    .lb-bar { position: fixed; top: 0; left: 0; right: 0; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; background: linear-gradient(to bottom, rgba(0,0,0,.85), transparent); z-index: 10; }
    .lb-close { width: 38px; height: 38px; border-radius: 50%; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px; color: #fff; }
    .lb-counter { color: #d1d5db; font-weight: 600; font-size: 14px; }
    #lb-img { max-width: 96vw; max-height: 80vh; object-fit: contain; border-radius: 8px; user-select: none; }
    .lb-nav { position: fixed; top: 50%; transform: translateY(-50%); width: 42px; height: 42px; border-radius: 50%; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 20px; color: #fff; z-index: 10; }
    #lb-prev { left: 8px; } #lb-next { right: 8px; }

    @media (max-width: 760px) {
      .brand-header { padding: 18px 14px 16px; }
      .brand-name { font-size: 23px; }
      .photo-hero { width: 100%; margin-top: 0; border-radius: 0; aspect-ratio: 4/3; max-height: 360px; }
      .thumb-row { width: calc(100% - 24px); gap: 6px; margin-top: 8px; }
      .thumb { aspect-ratio: 1; border-radius: 7px; }
      .body { width: calc(100% - 28px); padding-bottom: 120px; }
      .title-block { padding-top: 22px; }
      .detail-grid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
      .drow { padding: 12px 11px; gap: 8px; }
      .dicon { font-size: 17px; }
      .dval { font-size: 13px; }
      .price-block { padding: 18px; }
      .footer { padding: 16px 14px 18px; }
    }
    @media (max-width: 380px) {
      .detail-grid { grid-template-columns: 1fr; }
      .prop-title { font-size: 24px; }
    }

    /* Final premium polish: editorial real-estate look, clearer hierarchy */
    body { background: #f3f5f8; color: #172033; }
    .brand-header { position: relative; overflow: hidden; padding: 24px 20px 22px; background: linear-gradient(115deg,#0c172b 0%,#172744 58%,#0c172b 100%); }
    .brand-header::after { content: ''; position: absolute; width: 280px; height: 280px; border: 1px solid rgba(214,184,105,.18); border-radius: 50%; right: -90px; top: -170px; box-shadow: 0 0 0 28px rgba(214,184,105,.035),0 0 0 58px rgba(214,184,105,.025); pointer-events: none; }
    .brand-logo { letter-spacing: 3.5px; color: #d7bd79; }
    .brand-name { letter-spacing: 2.5px; font-size: 30px; }
    .brand-tagline { letter-spacing: 1.8px; }
    .photo-hero { margin-top: 28px; border-radius: 20px; aspect-ratio: 16/7; box-shadow: 0 18px 45px rgba(16,27,50,.13); }
    .thumb-row { gap: 10px; margin-top: 10px; }
    .thumb { border-radius: 12px; }
    .body { padding-bottom: 130px; }
    .title-block { padding: 30px 0 22px; }
    .badge { border-radius: 999px; padding: 6px 12px; }
    .badge-status { font-size: 11px; }
    .prop-title { letter-spacing: -.7px; }
    .prop-location { font-size: 15px; }
    .price-block { position: relative; overflow: hidden; border-radius: 18px; padding: 24px 26px; box-shadow: 0 10px 28px rgba(16,27,50,.055); }
    .price-block::after { content: '₹'; position: absolute; right: 22px; top: -22px; font-size: 118px; line-height: 1; font-weight: 900; color: rgba(185,149,59,.07); pointer-events: none; }
    .price-value { position: relative; z-index: 1; }
    .section { margin: 32px 0; }
    .section-title { font-size: 12px; letter-spacing: 1.8px; margin-bottom: 16px; }
    .detail-grid { gap: 12px; }
    .drow { min-height: 78px; border-radius: 14px; padding: 16px; transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
    .drow:hover { transform: translateY(-2px); border-color: #d7c48d; box-shadow: 0 8px 20px rgba(16,27,50,.06); }
    .dicon { width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; background: #f7f3e8; border-radius: 10px; font-size: 17px; }
    .dlabel { letter-spacing: .85px; }
    .dval { font-size: 14px; }
    .chip { border-radius: 999px; padding: 8px 13px; }
    .chip.gold { background: #f8f2e3; }
    .possession-banner { border-radius: 14px; padding: 18px 20px; }
    .doc-item { border-radius: 12px; }
    .footer { background: linear-gradient(to top,rgba(243,245,248,1) 70%,rgba(243,245,248,0)); }
    .cta-btn { border-radius: 12px; min-height: 54px; }
    .expiry-bar { color: #80621c; }
    @media (min-width: 761px) {
      .photo-hero { max-height: 510px; }
      .body { display: grid; grid-template-columns: minmax(0,1fr); }
      .title-block { padding-top: 32px; }
      .price-block { max-width: 100%; }
      .detail-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }
    }
    @media (max-width: 760px) {
      .brand-name { font-size: 24px; }
      .photo-hero { margin-top: 0; }
      .body { padding-bottom: 120px; }
      .title-block { padding-top: 24px; }
      .price-block { margin: 18px 0; }
      .section { margin: 26px 0; }
      .drow { min-height: 72px; }
    }
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
