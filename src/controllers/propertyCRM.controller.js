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
    const expiry = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hrs
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
    if (req.params.token) {
      property = await Property.findOne({
        shareToken: req.params.token,
        shareTokenExpiry: { $gt: new Date() },
      });
      if (!property) {
        return res.status(410).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Expired</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d1117;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{background:#161b22;border:1px solid #30363d;border-radius:20px;padding:48px 36px;text-align:center;max-width:380px;width:90%}.icon{font-size:56px;margin-bottom:20px}.title{font-size:22px;font-weight:800;color:#e6edf3;margin-bottom:10px}.sub{font-size:14px;color:#8b949e;line-height:1.6}</style></head><body><div class="card"><div class="icon">⏰</div><div class="title">Link Expired</div><div class="sub">This property link was valid for 48 hours and has expired.<br><br>Ask the agent to send you a fresh link.</div></div></body></html>`);
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
      if (isNaN(num) || num === 0) return String(n);
      if (num >= 10000000) return `₹${(num/10000000).toFixed(2).replace(/\.?0+$/,'')} Cr`;
      if (num >= 100000)   return `₹${(num/100000).toFixed(2).replace(/\.?0+$/,'')} L`;
      return `₹${num.toLocaleString('en-IN')}`;
    }

    const SVG_ICONS = {
      home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>`,
      carpet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>`,
      buildup: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20M5 20V8l7-5 7 5v12"/><path d="M10 20v-5h4v5"/></svg>`,
      floors: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M3 13h18M3 18h18"/></svg>`,
      facing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="2.5"/></svg>`,
      lift: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 10l3-3 3 3M9 14l3 3 3-3"/></svg>`,
      parking: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 17V7h4a3 3 0 010 6H9"/></svg>`,
      water: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6 9 4 13 4 16a8 8 0 0016 0c0-3-2-7-8-14z"/></svg>`,
      sanction: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
      furnishing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9V6a1 1 0 011-1h16a1 1 0 011 1v3"/><path d="M3 9a2 2 0 00-2 2v6h22v-6a2 2 0 00-2-2H3z"/><path d="M5 17v2M19 17v2"/></svg>`,
      age: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
      flats: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><path d="M12 12v3M10 14h4"/></svg>`,
      type: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    };
    function card(iconKey, label, value) {
      if (!value) return '';
      const svg = SVG_ICONS[iconKey] || SVG_ICONS.type;
      return `<div class="dc"><div class="dc-icon">${svg}</div><div class="dc-label">${label}</div><div class="dc-val">${value}</div></div>`;
    }

    const priceDisplay = isRent
      ? (p.monthlyRent ? `₹${Number(String(p.monthlyRent).replace(/,/g,'')||0).toLocaleString('en-IN')}/mo` : fmt(p.price))
      : fmt(p.price);

    const statusColor  = p.status === 'available' ? '#22c55e' : p.status === 'sold' ? '#ef4444' : '#f59e0b';
    const statusBg     = p.status === 'available' ? '#052e16' : p.status === 'sold' ? '#450a0a' : '#431407';
    const statusLabel  = p.status === 'available' ? 'Available' : p.status === 'sold' ? 'Sold' : 'Rented';

    // ── Photo gallery HTML ───────────────────────────────────────────────────
    const cameraSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
    const expandSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;
    const buildingSVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="48" height="48"><rect x="2" y="7" width="20" height="15" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><line x1="12" y1="12" x2="12" y2="12.01"/></svg>`;
    const galleryHTML = photos.length ? `
      <div class="gallery">
        <div class="gallery-hero" onclick="openLb(0)">
          <img src="${photos[0]}" alt="Property photo" loading="eager">
          <div class="gallery-overlay">${expandSVG}<span>View all photos</span></div>
          <div class="gallery-badge">${cameraSVG}<span>${photos.length} photo${photos.length > 1 ? 's' : ''}</span></div>
        </div>
        ${photos.length > 1 ? `
        <div class="gallery-thumbs">
          ${photos.slice(1, 5).map((u, i) => `
            <div class="gallery-thumb" onclick="openLb(${i+1})">
              <img src="${u}" loading="lazy">
              ${i === 3 && photos.length > 5 ? `<div class="gallery-thumb-more">+${photos.length - 5}</div>` : ''}
            </div>`).join('')}
        </div>` : ''}
      </div>` : `
      <div class="no-photo">
        <div class="no-photo-icon">${buildingSVG}</div>
        <p>No photos available</p>
      </div>`;

    const lbPhotos = JSON.stringify(photos);

    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src *; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src https://fonts.gstatic.com; connect-src 'none';");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0b1220">
  <title>KIN Property Management</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#f4f6f9;
      --surface:#ffffff;
      --border:#e8eaee;
      --navy:#0b1220;
      --navy2:#162033;
      --navy3:#1e2d45;
      --gold:#b8892e;
      --gold2:#d4a84b;
      --gold-light:#fdf6e8;
      --gold-mid:#f5e6c3;
      --text:#0f1923;
      --text2:#374151;
      --muted:#6b7280;
      --muted2:#9ca3af;
      --green:#15803d;
      --wa:#25d366;
      --radius:14px;
      --radius-sm:10px;
      --shadow:0 1px 2px rgba(0,0,0,.04),0 3px 12px rgba(0,0,0,.05);
      --shadow-md:0 4px 20px rgba(0,0,0,.08);
      --shadow-lg:0 8px 40px rgba(0,0,0,.12);
    }
    html{scroll-behavior:smooth;-webkit-tap-highlight-color:transparent}
    body{
      background:var(--bg);color:var(--text);
      font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      min-height:100vh;line-height:1.5;padding-bottom:110px;
    }

    /* ── Header ── */
    .header{
      background:var(--navy);
      padding-top:env(safe-area-inset-top,0);
      position:relative;overflow:hidden;
    }
    .header::after{
      content:'';position:absolute;inset:0;
      background:radial-gradient(ellipse 80% 60% at 50% 120%,rgba(184,137,46,.14) 0%,transparent 70%);
      pointer-events:none;
    }
    .header-strip{
      height:3px;
      background:linear-gradient(90deg,transparent 0%,var(--gold) 30%,var(--gold2) 50%,var(--gold) 70%,transparent 100%);
    }
    .header-body{
      max-width:720px;margin:0 auto;
      padding:28px 20px 26px;
      display:flex;flex-direction:column;align-items:center;
      position:relative;z-index:1;
    }
    .header-badge{
      display:inline-flex;align-items:center;gap:7px;
      background:rgba(184,137,46,.12);border:1px solid rgba(184,137,46,.25);
      border-radius:999px;padding:5px 14px;margin-bottom:14px;
    }
    .header-badge-dot{width:5px;height:5px;border-radius:50%;background:var(--gold2);flex-shrink:0}
    .header-badge-text{font-size:10px;font-weight:700;color:var(--gold2);letter-spacing:1.8px;text-transform:uppercase}
    .header-name{
      font-size:clamp(22px,5vw,30px);font-weight:900;
      color:#ffffff;letter-spacing:-.3px;line-height:1.1;
      text-align:center;
    }
    .header-name span{color:var(--gold2)}
    .header-sub{
      font-size:12px;font-weight:500;color:rgba(255,255,255,.4);
      margin-top:7px;letter-spacing:.6px;
    }
    .header-divider{
      width:48px;height:2px;margin:16px auto 0;
      background:linear-gradient(90deg,transparent,var(--gold2),transparent);
      border-radius:2px;
    }

    /* ── Gallery ── */
    .gallery{max-width:720px;margin:20px auto 0;padding:0 16px}
    .gallery-hero{
      position:relative;border-radius:var(--radius);overflow:hidden;
      aspect-ratio:4/3;cursor:pointer;background:#d9dde5;
      box-shadow:var(--shadow-lg);
    }
    @media(min-width:500px){.gallery-hero{aspect-ratio:16/9}}
    .gallery-hero img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s cubic-bezier(.25,.46,.45,.94)}
    .gallery-hero:hover img,.gallery-hero:active img{transform:scale(1.04)}
    .gallery-overlay{
      position:absolute;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:8px;
      background:rgba(11,18,32,0);color:#fff;font-size:13px;font-weight:600;
      opacity:0;transition:all .3s ease;letter-spacing:.3px;
    }
    .gallery-overlay svg{stroke:#fff;width:22px;height:22px}
    .gallery-hero:hover .gallery-overlay,.gallery-hero:active .gallery-overlay{opacity:1;background:rgba(11,18,32,.45)}
    .gallery-badge{
      position:absolute;bottom:12px;right:12px;
      background:rgba(11,18,32,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
      color:#fff;font-size:11px;font-weight:600;padding:6px 12px;border-radius:8px;
      display:flex;align-items:center;gap:5px;letter-spacing:.2px;
      border:1px solid rgba(255,255,255,.08);
    }
    .gallery-badge svg{stroke:#fff;flex-shrink:0}
    .gallery-thumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px}
    .gallery-thumb{
      position:relative;aspect-ratio:1;border-radius:var(--radius-sm);overflow:hidden;
      cursor:pointer;background:#d9dde5;
    }
    .gallery-thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .25s ease}
    .gallery-thumb:hover img,.gallery-thumb:active img{transform:scale(1.07)}
    .gallery-thumb-more{
      position:absolute;inset:0;
      background:rgba(11,18,32,.65);backdrop-filter:blur(2px);
      display:flex;align-items:center;justify-content:center;
      color:#fff;font-size:15px;font-weight:700;letter-spacing:-.3px;
    }
    .no-photo{
      max-width:720px;margin:20px auto 0;padding:52px 24px;text-align:center;
      background:var(--surface);border:1.5px dashed var(--border);border-radius:var(--radius);
    }
    .no-photo-icon{margin-bottom:12px;display:flex;justify-content:center}
    .no-photo-icon svg{stroke:#c4c9d4}
    .no-photo p{color:var(--muted2);font-size:13px;font-weight:500}

    /* ── Property title block ── */
    .prop-title-block{
      max-width:720px;margin:20px auto 0;padding:0 16px;
    }
    .prop-title{font-size:clamp(20px,4.5vw,26px);font-weight:900;color:var(--text);line-height:1.2;letter-spacing:-.3px}
    .prop-addr{font-size:13px;color:var(--muted);margin-top:5px;font-weight:500}

    /* ── Main content ── */
    .content{max-width:720px;margin:0 auto;padding:16px 16px 0}

    /* Status + listing row */
    .tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
    .tag{
      display:inline-flex;align-items:center;gap:4px;
      padding:5px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.3px;
    }
    .tag-status{background:${statusBg};color:${statusColor};border:1px solid ${statusColor}35}
    .tag-listing{background:#1a1200;color:#d4a017;border:1px solid rgba(212,160,23,.25)}
    .tag-type{background:#f0f2f5;color:var(--text2);border:1px solid var(--border)}

    /* Location card */
    .loc-card{
      background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
      padding:16px 18px;margin-bottom:10px;display:flex;align-items:center;gap:14px;
      box-shadow:var(--shadow);
    }
    .loc-icon{
      width:42px;height:42px;border-radius:11px;
      background:linear-gradient(135deg,var(--navy2),var(--navy3));
      display:flex;align-items:center;justify-content:center;flex-shrink:0;
    }
    .loc-icon svg{stroke:#fff}
    .loc-name{font-size:15px;font-weight:700;color:var(--text);line-height:1.3}
    .loc-nearby{font-size:12px;color:var(--muted);margin-top:2px;font-weight:500}

    /* Price card */
    .price-card{
      background:linear-gradient(135deg,var(--navy) 0%,var(--navy3) 100%);
      border-radius:var(--radius);padding:22px 22px 20px;margin-bottom:10px;
      position:relative;overflow:hidden;box-shadow:var(--shadow-lg);
      border:1px solid rgba(184,137,46,.15);
    }
    .price-card::before{
      content:'';position:absolute;right:-30px;top:-30px;
      width:160px;height:160px;border-radius:50%;
      background:radial-gradient(circle,rgba(184,137,46,.12) 0%,transparent 70%);
      pointer-events:none;
    }
    .price-eyebrow{font-size:10px;color:rgba(255,255,255,.45);letter-spacing:1.8px;margin-bottom:8px;font-weight:600;text-transform:uppercase}
    .price-main{font-size:clamp(28px,6vw,38px);font-weight:900;color:#ffffff;line-height:1;position:relative;z-index:1;letter-spacing:-.5px}
    .price-main-accent{color:var(--gold2)}
    .price-sub{font-size:12px;color:rgba(255,255,255,.4);margin-top:8px;font-weight:500}
    .price-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
    .price-pill{
      background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
      border-radius:10px;padding:10px 14px;flex:1;min-width:120px;
    }
    .price-pill-label{font-size:9px;color:rgba(255,255,255,.4);letter-spacing:1px;font-weight:600;text-transform:uppercase}
    .price-pill-val{font-size:15px;font-weight:800;color:#e8edf5;margin-top:4px}

    /* Possession banner */
    .poss-banner{
      border-radius:var(--radius);padding:14px 18px;margin-bottom:10px;
      display:flex;align-items:center;gap:14px;
      box-shadow:var(--shadow);
    }
    .poss-banner.rtm{background:#071d10;border:1px solid rgba(22,163,74,.3)}
    .poss-banner.uc{background:#1c0f04;border:1px solid rgba(245,158,11,.3)}
    .poss-icon{flex-shrink:0;display:flex;align-items:center;justify-content:center}
    .poss-banner.rtm .poss-icon svg{stroke:#4ade80}
    .poss-banner.uc .poss-icon svg{stroke:#fbbf24}
    .poss-title{font-size:14px;font-weight:700}
    .poss-banner.rtm .poss-title{color:#4ade80}
    .poss-banner.uc .poss-title{color:#fbbf24}
    .poss-sub{font-size:12px;color:rgba(255,255,255,.4);margin-top:2px;font-weight:500}

    /* Section */
    .section{margin-bottom:10px}
    .section-head{
      display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:0 2px;
    }
    .section-head-label{
      font-size:10px;font-weight:700;color:var(--muted);
      letter-spacing:1.6px;white-space:nowrap;text-transform:uppercase;
    }
    .section-head-line{flex:1;height:1px;background:var(--border)}

    /* Detail cards grid */
    .dc-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
    @media(min-width:480px){.dc-grid{grid-template-columns:repeat(3,1fr)}}
    .dc{
      background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
      padding:14px;display:flex;flex-direction:column;gap:8px;
      box-shadow:var(--shadow);
    }
    .dc-icon{
      width:30px;height:30px;border-radius:8px;
      background:var(--gold-light);border:1px solid var(--gold-mid);
      display:flex;align-items:center;justify-content:center;flex-shrink:0;
    }
    .dc-icon svg{width:14px;height:14px;stroke:var(--gold)}
    .dc-label{font-size:9px;font-weight:700;color:var(--muted2);letter-spacing:.8px;text-transform:uppercase}
    .dc-val{font-size:13px;font-weight:700;color:var(--text);line-height:1.3;overflow-wrap:anywhere}

    /* Amenities */
    .amenity-list{display:flex;flex-wrap:wrap;gap:6px}
    .amenity-chip{
      background:var(--surface);border:1px solid var(--border);border-radius:8px;
      padding:7px 12px;font-size:12px;font-weight:600;color:var(--text2);
      display:flex;align-items:center;gap:5px;
    }
    .amenity-check{stroke:var(--gold);flex-shrink:0}

    /* Documents */
    .doc-list{display:flex;flex-direction:column;gap:6px}
    .doc-item{
      background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);
      padding:12px 15px;display:flex;align-items:center;gap:10px;
      font-size:13px;font-weight:600;color:var(--text2);box-shadow:var(--shadow);
    }
    .doc-item-icon{flex-shrink:0;display:flex;align-items:center}
    .doc-item-icon svg{stroke:var(--gold)}

    /* Notes */
    .notes-box{
      background:var(--surface);
      border:1px solid var(--border);border-left:3px solid var(--gold2);
      border-radius:var(--radius);padding:15px 16px;font-size:13px;
      color:var(--text2);line-height:1.75;box-shadow:var(--shadow);
    }

    /* WhatsApp CTA */
    .cta-wrap{
      position:fixed;bottom:0;left:0;right:0;z-index:50;
      background:linear-gradient(to top,var(--bg) 60%,rgba(244,246,249,0));
      padding:20px 16px max(16px,env(safe-area-inset-bottom,16px));
    }
    .cta-btn{
      display:flex;align-items:center;justify-content:center;gap:10px;
      background:linear-gradient(135deg,#1da851,#25d366);
      color:#fff;text-decoration:none;
      font-size:15px;font-weight:700;letter-spacing:.1px;
      border-radius:var(--radius);padding:16px 24px;
      max-width:680px;margin:0 auto;
      box-shadow:0 4px 20px rgba(37,211,102,.3);
      transition:transform .15s,box-shadow .15s;
    }
    .cta-btn:active{transform:scale(.98);box-shadow:0 2px 10px rgba(37,211,102,.25)}
    .cta-icon{display:flex;align-items:center;line-height:1}
    .cta-icon svg{fill:#fff}
    .cta-no-phone{text-align:center;color:var(--muted);font-size:13px;max-width:680px;margin:0 auto;font-weight:500}

    /* Expiry notice */
    .expiry{
      max-width:720px;margin:12px auto 0;padding:10px 16px;
      display:flex;align-items:center;justify-content:center;gap:6px;
      background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);
      font-size:11px;color:var(--muted2);font-weight:600;letter-spacing:.2px;
    }
    .expiry svg{stroke:var(--muted2);flex-shrink:0}

    /* Lightbox */
    #lb{
      display:none;position:fixed;inset:0;z-index:9999;
      background:rgba(5,8,14,.97);flex-direction:column;
      align-items:center;justify-content:center;
    }
    #lb.open{display:flex}
    .lb-header{
      position:absolute;top:0;left:0;right:0;
      padding:max(16px,env(safe-area-inset-top,16px)) 16px 20px;
      display:flex;align-items:center;justify-content:space-between;
      background:linear-gradient(to bottom,rgba(5,8,14,.85),transparent);
    }
    .lb-count{color:rgba(255,255,255,.7);font-size:13px;font-weight:600;letter-spacing:.3px}
    .lb-close{
      width:36px;height:36px;border-radius:50%;
      background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;transition:background .15s;
    }
    .lb-close:hover{background:rgba(255,255,255,.18)}
    .lb-close svg{stroke:#fff}
    #lb-img{max-width:94vw;max-height:78vh;object-fit:contain;border-radius:8px;user-select:none}
    .lb-arrow{
      position:absolute;top:50%;transform:translateY(-50%);
      width:42px;height:42px;border-radius:50%;
      background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;transition:background .15s;z-index:10;
    }
    .lb-arrow:hover{background:rgba(255,255,255,.16)}
    .lb-arrow svg{stroke:#fff}
    #lb-prev{left:12px}#lb-next{right:12px}
    .lb-arrow.disabled{opacity:.25;pointer-events:none}
  </style>
</head>
<body>

  <!-- ── Header ── -->
  <div class="header">
    <div class="header-strip"></div>
    <div class="header-body">
      <div class="header-badge">
        <div class="header-badge-dot"></div>
        <div class="header-badge-text">Real Estate</div>
      </div>
      <div class="header-name">KIN <span>Property</span> Management</div>
      <div class="header-sub">Your Property · Our Trust</div>
      <div class="header-divider"></div>
    </div>
  </div>

  <!-- ── Gallery ── -->
  ${galleryHTML}

  <!-- ── Property Title ── -->
  <div class="prop-title-block">
    <div class="prop-title">${p.projectName || ''}</div>
    ${p.address ? `<div class="prop-addr">${p.address}</div>` : ''}
  </div>

  <!-- ── Content ── -->
  <div class="content">

    <!-- Tags -->
    <div class="tags">
      <span class="tag tag-status">● ${statusLabel}</span>
      <span class="tag tag-listing">${isRent ? 'For Rent' : 'For Sale'}</span>
      ${p.propertyType ? `<span class="tag tag-type">${p.propertyType}</span>` : ''}
      ${p.flatConfig   ? `<span class="tag tag-type">${p.flatConfig}</span>`   : ''}
    </div>

    <!-- Location -->
    <div class="loc-card">
      <div class="loc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg></div>
      <div>
        <div class="loc-name">${p.location || '—'}</div>
        ${p.nearbyLocalities ? `<div class="loc-nearby">Near: ${p.nearbyLocalities}</div>` : ''}
      </div>
    </div>

    <!-- Price -->
    <div class="price-card">
      <div class="price-eyebrow">${isRent ? 'Monthly Rent' : 'Sale Price'}</div>
      <div class="price-main">${priceDisplay || '—'}</div>
      ${p.maintenance ? `<div class="price-sub">+ ₹${p.maintenance}/mo maintenance</div>` : ''}
      ${isRent && (p.securityDeposit || p.monthlyRent) ? `
      <div class="price-pills">
        ${p.monthlyRent    ? `<div class="price-pill"><div class="price-pill-label">Monthly Rent</div><div class="price-pill-val">₹${Number(String(p.monthlyRent).replace(/,/g,'')||0).toLocaleString('en-IN')}</div></div>` : ''}
        ${p.securityDeposit ? `<div class="price-pill"><div class="price-pill-label">Security Deposit</div><div class="price-pill-val">₹${Number(String(p.securityDeposit).replace(/,/g,'')||0).toLocaleString('en-IN')}</div></div>` : ''}
      </div>` : ''}
    </div>

    <!-- Possession -->
    ${p.possession ? `
    <div class="poss-banner ${p.possession === 'Ready to Move' ? 'rtm' : 'uc'}">
      <div class="poss-icon">${p.possession === 'Ready to Move'
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="26" height="26"><path d="M20 6L9 17l-5-5"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="26" height="26"><rect x="2" y="14" width="20" height="8" rx="1"/><path d="M6 14V8a2 2 0 012-2h3"/><path d="M18 14V8"/><path d="M12 2l6 6H6l6-6z"/></svg>`
      }</div>
      <div>
        <div class="poss-title">${p.possession}</div>
        ${p.possessionDate ? `<div class="poss-sub">Expected: ${p.possessionDate}</div>` : ''}
      </div>
    </div>` : ''}

    <!-- Property Details -->
    <div class="section">
      <div class="section-head"><div class="section-head-label">Property Details</div><div class="section-head-line"></div></div>
      <div class="dc-grid">
        ${card('type','Type', p.propertyType)}
        ${card('carpet','Carpet Area', p.carpetArea)}
        ${card('buildup','Buildup Area', p.buildupArea)}
        ${card('floors','Total Floors', p.totalFloors)}
        ${card('facing','Facing', p.facing)}
        ${card('lift','Lift', p.lift)}
        ${card('parking','Parking', p.parking)}
        ${card('water','Water', p.water)}
        ${card('sanction','Sanction', p.sanction)}
        ${card('furnishing','Furnishing', p.furnishing)}
        ${card('age','Property Age', p.propertyAge)}
        ${p.flatsOnFloor ? card('flats','Flats/Floor', p.flatsOnFloor) : ''}
      </div>
    </div>

    <!-- Amenities -->
    ${p.amenities && p.amenities.length ? `
    <div class="section">
      <div class="section-head"><div class="section-head-label">Amenities</div><div class="section-head-line"></div></div>
      <div class="amenity-list">
        ${p.amenities.map(a => `<div class="amenity-chip"><svg class="amenity-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><polyline points="20 6 9 17 4 12"/></svg>${a}</div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Documents -->
    ${p.documents && p.documents.length ? `
    <div class="section">
      <div class="section-head"><div class="section-head-label">Documents Available</div><div class="section-head-line"></div></div>
      <div class="doc-list">
        ${p.documents.map(d => `<div class="doc-item"><div class="doc-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg></div>${d}</div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Notes -->
    ${p.notes ? `
    <div class="section">
      <div class="section-head"><div class="section-head-label">Additional Info</div><div class="section-head-line"></div></div>
      <div class="notes-box">${p.notes}</div>
    </div>` : ''}

    <!-- Expiry -->
    ${req.params.token ? `<div class="expiry"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> This link is valid for 48 hours</div>` : ''}

  </div><!-- /content -->

  <!-- ── WhatsApp CTA ── -->
  <div class="cta-wrap">
    ${p.ownerPhone
      ? `<a class="cta-btn" href="https://wa.me/91${p.ownerPhone.replace(/\D/g,'')}?text=${encodeURIComponent(`Hi, I'm interested in the property at ${p.location}. Can you share more details?`)}">
          <span class="cta-icon"><svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.126 1.532 5.857L.057 23.882a.5.5 0 00.61.61l6.025-1.475A11.944 11.944 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.808 9.808 0 01-5.006-1.37l-.36-.214-3.714.91.927-3.601-.235-.37A9.818 9.818 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/></svg></span> Enquire on WhatsApp
        </a>`
      : `<div class="cta-no-phone">Contact your agent for more details</div>`}
  </div>

  <!-- ── Lightbox ── -->
  <div id="lb">
    <div class="lb-header">
      <div class="lb-close" onclick="closeLb()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>
      <div class="lb-count" id="lbCount"></div>
      <div style="width:36px"></div>
    </div>
    <img id="lb-img" src="" alt="Property photo">
    ${photos.length > 1 ? `
    <div class="lb-arrow" id="lb-prev" onclick="navLb(-1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="15 18 9 12 15 6"/></svg></div>
    <div class="lb-arrow" id="lb-next" onclick="navLb(1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="9 18 15 12 9 6"/></svg></div>` : ''}
  </div>

  <script>
    const PHOTOS = ${lbPhotos};
    let cur = 0;
    function updLb() {
      document.getElementById('lb-img').src = PHOTOS[cur];
      document.getElementById('lbCount').textContent = PHOTOS.length ? (cur+1) + ' / ' + PHOTOS.length : '';
      const prev = document.getElementById('lb-prev');
      const next = document.getElementById('lb-next');
      if (prev) prev.classList.toggle('disabled', cur <= 0);
      if (next) next.classList.toggle('disabled', cur >= PHOTOS.length - 1);
    }
    function openLb(i) {
      cur = i; updLb();
      document.getElementById('lb').classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function closeLb() {
      document.getElementById('lb').classList.remove('open');
      document.body.style.overflow = '';
    }
    function navLb(d) {
      const n = cur + d;
      if (n >= 0 && n < PHOTOS.length) { cur = n; updLb(); }
    }
    document.getElementById('lb').addEventListener('click', e => { if (e.target === document.getElementById('lb')) closeLb(); });
    let sx = 0;
    document.getElementById('lb').addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    document.getElementById('lb').addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 45 && PHOTOS.length > 1) navLb(dx < 0 ? 1 : -1);
    });
    document.addEventListener('keydown', e => {
      if (!document.getElementById('lb').classList.contains('open')) return;
      if (e.key === 'ArrowLeft') navLb(-1);
      if (e.key === 'ArrowRight') navLb(1);
      if (e.key === 'Escape') closeLb();
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