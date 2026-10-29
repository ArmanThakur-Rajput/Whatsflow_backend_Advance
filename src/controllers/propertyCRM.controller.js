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

    function card(icon, label, value) {
      if (!value) return '';
      return `<div class="dc"><div class="dc-icon">${icon}</div><div class="dc-label">${label}</div><div class="dc-val">${value}</div></div>`;
    }

    const priceDisplay = isRent
      ? (p.monthlyRent ? `₹${Number(String(p.monthlyRent).replace(/,/g,'')||0).toLocaleString('en-IN')}/mo` : fmt(p.price))
      : fmt(p.price);

    const statusColor  = p.status === 'available' ? '#22c55e' : p.status === 'sold' ? '#ef4444' : '#f59e0b';
    const statusBg     = p.status === 'available' ? '#052e16' : p.status === 'sold' ? '#450a0a' : '#431407';
    const statusLabel  = p.status === 'available' ? 'Available' : p.status === 'sold' ? 'Sold' : 'Rented';

    // ── Photo gallery HTML ───────────────────────────────────────────────────
    const galleryHTML = photos.length ? `
      <div class="gallery">
        <div class="gallery-hero" onclick="openLb(0)">
          <img src="${photos[0]}" alt="Property photo" loading="eager">
          <div class="gallery-overlay"><span class="gallery-overlay-icon">⊕</span> View Photos</div>
          <div class="gallery-badge"><span>📷</span> ${photos.length} photo${photos.length > 1 ? 's' : ''}</div>
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
        <div class="no-photo-icon">🏠</div>
        <p>No photos available</p>
      </div>`;

    const lbPhotos = JSON.stringify(photos);

    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src *; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src https://fonts.gstatic.com; connect-src 'none';");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0d1117">
  <title>KIN Property Management</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#f0f2f5;
      --surface:#ffffff;
      --surface2:#f8f9fb;
      --border:#e4e7ec;
      --navy:#0d1b2a;
      --navy2:#1a2d45;
      --gold:#c49a3c;
      --gold-light:#fdf5e6;
      --text:#111827;
      --muted:#6b7280;
      --green:#16a34a;
      --green-dark:#14532d;
      --wa:#25d366;
      --radius:16px;
      --shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.06);
      --shadow-lg:0 8px 32px rgba(0,0,0,.10);
    }
    html{scroll-behavior:smooth;-webkit-tap-highlight-color:transparent}
    body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif;min-height:100vh;line-height:1.5;padding-bottom:100px}

    /* ── Header ── */
    .header{
      background:linear-gradient(135deg,#0d1b2a 0%,#1a2d45 50%,#0d1b2a 100%);
      padding:env(safe-area-inset-top,0) 20px 0;
      position:relative;overflow:hidden;
    }
    .header::before{
      content:'';position:absolute;width:320px;height:320px;
      border:1px solid rgba(196,154,60,.15);border-radius:50%;
      right:-80px;top:-200px;
      box-shadow:0 0 0 32px rgba(196,154,60,.04),0 0 0 64px rgba(196,154,60,.025);
      pointer-events:none;
    }
    .header-inner{max-width:680px;margin:0 auto;padding:24px 0 22px;text-align:center;position:relative}
    .header-eyebrow{font-size:9px;letter-spacing:4px;text-transform:uppercase;color:var(--gold);font-weight:700;margin-bottom:8px}
    .header-logo{font-size:26px;font-weight:900;color:#ffffff;letter-spacing:2px;line-height:1}
    .header-tagline{font-size:10px;color:#8fa3bc;letter-spacing:2px;margin-top:6px;text-transform:uppercase}
    .header-divider{height:3px;background:linear-gradient(90deg,transparent,var(--gold),transparent);margin-top:20px}

    /* ── Gallery ── */
    .gallery{max-width:720px;margin:24px auto 0;padding:0 16px}
    .gallery-hero{
      position:relative;border-radius:var(--radius);overflow:hidden;
      aspect-ratio:4/3;cursor:pointer;background:#dde1e7;
      box-shadow:var(--shadow-lg);
    }
    @media(min-width:500px){.gallery-hero{aspect-ratio:16/9}}
    .gallery-hero img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s ease}
    .gallery-hero:hover img{transform:scale(1.03)}
    .gallery-overlay{
      position:absolute;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:6px;
      background:rgba(13,27,42,0);color:#fff;font-size:13px;font-weight:700;
      opacity:0;transition:all .25s;letter-spacing:.3px;
    }
    .gallery-overlay-icon{font-size:28px;line-height:1}
    .gallery-hero:hover .gallery-overlay,.gallery-hero:active .gallery-overlay{opacity:1;background:rgba(13,27,42,.38)}
    .gallery-badge{
      position:absolute;bottom:12px;right:12px;
      background:rgba(13,27,42,.75);backdrop-filter:blur(6px);
      color:#fff;font-size:11px;font-weight:700;padding:6px 11px;border-radius:10px;
      display:flex;align-items:center;gap:5px;
    }
    .gallery-thumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px}
    .gallery-thumb{
      position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;
      cursor:pointer;background:#dde1e7;
    }
    .gallery-thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s}
    .gallery-thumb:hover img,.gallery-thumb:active img{transform:scale(1.06)}
    .gallery-thumb-more{
      position:absolute;inset:0;background:rgba(13,27,42,.6);
      display:flex;align-items:center;justify-content:center;
      color:#fff;font-size:16px;font-weight:800;
    }
    .no-photo{
      max-width:720px;margin:24px auto 0;padding:56px 24px;text-align:center;
      background:var(--surface);border:2px dashed var(--border);border-radius:var(--radius);
    }
    .no-photo-icon{font-size:42px;margin-bottom:10px}
    .no-photo p{color:var(--muted);font-size:14px}

    /* ── Main content ── */
    .content{max-width:720px;margin:0 auto;padding:20px 16px 0}

    /* Status + listing row */
    .tags{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
    .tag{
      display:inline-flex;align-items:center;gap:5px;
      padding:5px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.2px;
    }
    .tag-status{background:${statusBg};color:${statusColor};border:1px solid ${statusColor}40}
    .tag-listing{background:#1c1400;color:#d4a017;border:1px solid #d4a01740}
    .tag-type{background:#0f172a;color:#94a3b8;border:1px solid #94a3b820}

    /* Location card */
    .loc-card{
      background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
      padding:18px 20px;margin-bottom:12px;display:flex;align-items:center;gap:14px;
      box-shadow:var(--shadow);
    }
    .loc-icon{
      width:44px;height:44px;border-radius:12px;
      background:linear-gradient(135deg,#1e3a5f,#2a5298);
      display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;
    }
    .loc-name{font-size:17px;font-weight:800;color:var(--text);line-height:1.3}
    .loc-nearby{font-size:12px;color:var(--muted);margin-top:3px}

    /* Price card */
    .price-card{
      background:linear-gradient(135deg,#0d1b2a 0%,#1a2d45 100%);
      border-radius:var(--radius);padding:22px 22px 20px;margin-bottom:12px;
      position:relative;overflow:hidden;box-shadow:var(--shadow-lg);
    }
    .price-card::after{
      content:'₹';position:absolute;right:16px;top:-18px;
      font-size:110px;font-weight:900;color:rgba(196,154,60,.08);pointer-events:none;line-height:1;
    }
    .price-eyebrow{font-size:10px;color:#8fa3bc;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;font-weight:600}
    .price-main{font-size:clamp(28px,6vw,38px);font-weight:900;color:#ffffff;line-height:1;position:relative;z-index:1}
    .price-sub{font-size:12px;color:#8fa3bc;margin-top:8px}
    .price-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
    .price-pill{
      background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);
      border-radius:10px;padding:9px 14px;flex:1;min-width:120px;
    }
    .price-pill-label{font-size:9px;color:#8fa3bc;text-transform:uppercase;letter-spacing:.8px;font-weight:600}
    .price-pill-val{font-size:15px;font-weight:800;color:#e2e8f0;margin-top:3px}

    /* Possession banner */
    .poss-banner{
      border-radius:var(--radius);padding:16px 18px;margin-bottom:12px;
      display:flex;align-items:center;gap:14px;
      box-shadow:var(--shadow);
    }
    .poss-banner.rtm{background:#052e16;border:1px solid #16a34a40}
    .poss-banner.uc{background:#431407;border:1px solid #f59e0b40}
    .poss-icon{font-size:28px;flex-shrink:0}
    .poss-title{font-size:14px;font-weight:800}
    .poss-banner.rtm .poss-title{color:#4ade80}
    .poss-banner.uc .poss-title{color:#fbbf24}
    .poss-sub{font-size:12px;color:#94a3b8;margin-top:3px}

    /* Section */
    .section{margin-bottom:12px}
    .section-head{
      display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:0 4px;
    }
    .section-head-label{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1.4px;white-space:nowrap}
    .section-head-line{flex:1;height:1px;background:var(--border)}

    /* Detail cards grid */
    .dc-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
    @media(min-width:480px){.dc-grid{grid-template-columns:repeat(3,1fr)}}
    .dc{
      background:var(--surface);border:1px solid var(--border);border-radius:14px;
      padding:14px 14px 12px;display:flex;flex-direction:column;gap:6px;
      box-shadow:var(--shadow);transition:transform .15s,box-shadow .15s,border-color .15s;
    }
    .dc:active{transform:scale(.98)}
    .dc-icon{
      width:32px;height:32px;border-radius:9px;
      background:var(--gold-light);display:flex;align-items:center;justify-content:center;font-size:15px;
    }
    .dc-label{font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-top:2px}
    .dc-val{font-size:13px;font-weight:700;color:var(--text);line-height:1.3;overflow-wrap:anywhere}

    /* Amenities */
    .amenity-list{display:flex;flex-wrap:wrap;gap:7px}
    .amenity-chip{
      background:var(--surface);border:1px solid var(--border);border-radius:999px;
      padding:7px 13px;font-size:12px;font-weight:600;color:var(--text);
      display:flex;align-items:center;gap:5px;
    }
    .amenity-chip-dot{width:5px;height:5px;border-radius:50%;background:var(--gold);flex-shrink:0}

    /* Documents */
    .doc-list{display:flex;flex-direction:column;gap:7px}
    .doc-item{
      background:var(--surface);border:1px solid var(--border);border-radius:12px;
      padding:12px 15px;display:flex;align-items:center;gap:10px;
      font-size:13px;font-weight:600;color:var(--text);box-shadow:var(--shadow);
    }
    .doc-item-icon{font-size:18px;flex-shrink:0}

    /* Notes */
    .notes-box{
      background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--gold);
      border-radius:var(--radius);padding:15px 16px;font-size:13px;
      color:var(--muted);line-height:1.7;box-shadow:var(--shadow);
    }

    /* WhatsApp CTA */
    .cta-wrap{
      position:fixed;bottom:0;left:0;right:0;z-index:50;
      background:linear-gradient(to top,var(--bg) 65%,transparent);
      padding:20px 16px max(16px,env(safe-area-inset-bottom,16px));
    }
    .cta-btn{
      display:flex;align-items:center;justify-content:center;gap:10px;
      background:var(--wa);color:#fff;text-decoration:none;
      font-size:15px;font-weight:800;letter-spacing:.2px;
      border-radius:16px;padding:17px 24px;max-width:680px;margin:0 auto;
      box-shadow:0 6px 24px rgba(37,211,102,.35);
      transition:transform .15s,box-shadow .15s;
    }
    .cta-btn:active{transform:scale(.98);box-shadow:0 2px 10px rgba(37,211,102,.3)}
    .cta-icon{font-size:22px;line-height:1}
    .cta-no-phone{text-align:center;color:var(--muted);font-size:13px;max-width:680px;margin:0 auto}

    /* Expiry notice */
    .expiry{
      max-width:720px;margin:16px auto 0;padding:10px 16px;
      display:flex;align-items:center;justify-content:center;gap:7px;
      background:var(--surface);border:1px solid var(--border);border-radius:12px;
      font-size:11px;color:var(--muted);font-weight:600;
    }

    /* Lightbox */
    #lb{
      display:none;position:fixed;inset:0;z-index:9999;
      background:rgba(0,0,0,.97);flex-direction:column;
      align-items:center;justify-content:center;
    }
    #lb.open{display:flex}
    .lb-header{
      position:absolute;top:0;left:0;right:0;
      padding:max(16px,env(safe-area-inset-top,16px)) 16px 16px;
      display:flex;align-items:center;justify-content:space-between;
      background:linear-gradient(to bottom,rgba(0,0,0,.8),transparent);
    }
    .lb-count{color:#e5e7eb;font-size:13px;font-weight:700}
    .lb-close{
      width:36px;height:36px;border-radius:50%;
      background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;color:#fff;font-size:16px;
    }
    #lb-img{max-width:94vw;max-height:78vh;object-fit:contain;border-radius:8px;user-select:none}
    .lb-arrow{
      position:absolute;top:50%;transform:translateY(-50%);
      width:40px;height:40px;border-radius:50%;
      background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;color:#fff;font-size:22px;z-index:10;
    }
    #lb-prev{left:10px}#lb-next{right:10px}
    .lb-arrow.disabled{opacity:.3;pointer-events:none}
  </style>
</head>
<body>

  <!-- ── Header ── -->
  <div class="header">
    <div class="header-inner">
      <div class="header-eyebrow">Real Estate</div>
      <div class="header-logo">KIN PROPERTY</div>
      <div class="header-tagline">Your Property · Our Trust</div>
    </div>
    <div class="header-divider"></div>
  </div>

  <!-- ── Gallery ── -->
  ${galleryHTML}

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
      <div class="loc-icon">📍</div>
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
      <div class="poss-icon">${p.possession === 'Ready to Move' ? '✅' : '🏗️'}</div>
      <div>
        <div class="poss-title">${p.possession}</div>
        ${p.possessionDate ? `<div class="poss-sub">Expected: ${p.possessionDate}</div>` : ''}
      </div>
    </div>` : ''}

    <!-- Property Details -->
    <div class="section">
      <div class="section-head"><div class="section-head-label">Property Details</div><div class="section-head-line"></div></div>
      <div class="dc-grid">
        ${card('🏠','Type', p.propertyType)}
        ${card('📐','Carpet Area', p.carpetArea)}
        ${card('📏','Buildup Area', p.buildupArea)}
        ${card('🏗️','Total Floors', p.totalFloors)}
        ${card('🧭','Facing', p.facing)}
        ${card('🛗','Lift', p.lift)}
        ${card('🚗','Parking', p.parking)}
        ${card('💧','Water', p.water)}
        ${card('✅','Sanction', p.sanction)}
        ${card('🛋️','Furnishing', p.furnishing)}
        ${card('📅','Property Age', p.propertyAge)}
        ${p.flatsOnFloor ? card('🔢','Flats/Floor', p.flatsOnFloor) : ''}
      </div>
    </div>

    <!-- Amenities -->
    ${p.amenities && p.amenities.length ? `
    <div class="section">
      <div class="section-head"><div class="section-head-label">Amenities</div><div class="section-head-line"></div></div>
      <div class="amenity-list">
        ${p.amenities.map(a => `<div class="amenity-chip"><div class="amenity-chip-dot"></div>${a}</div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Documents -->
    ${p.documents && p.documents.length ? `
    <div class="section">
      <div class="section-head"><div class="section-head-label">Documents Available</div><div class="section-head-line"></div></div>
      <div class="doc-list">
        ${p.documents.map(d => `<div class="doc-item"><div class="doc-item-icon">📄</div>${d}</div>`).join('')}
      </div>
    </div>` : ''}

    <!-- Notes -->
    ${p.notes ? `
    <div class="section">
      <div class="section-head"><div class="section-head-label">Additional Info</div><div class="section-head-line"></div></div>
      <div class="notes-box">${p.notes}</div>
    </div>` : ''}

    <!-- Expiry -->
    ${req.params.token ? `<div class="expiry">🔗 This link is valid for 48 hours</div>` : ''}

  </div><!-- /content -->

  <!-- ── WhatsApp CTA ── -->
  <div class="cta-wrap">
    ${p.ownerPhone
      ? `<a class="cta-btn" href="https://wa.me/91${p.ownerPhone.replace(/\D/g,'')}?text=${encodeURIComponent(`Hi, I'm interested in the property at ${p.location}. Can you share more details?`)}">
          <span class="cta-icon">💬</span> Contact on WhatsApp
        </a>`
      : `<div class="cta-no-phone">Contact your agent for more details</div>`}
  </div>

  <!-- ── Lightbox ── -->
  <div id="lb">
    <div class="lb-header">
      <div class="lb-close" onclick="closeLb()">✕</div>
      <div class="lb-count" id="lbCount"></div>
      <div style="width:36px"></div>
    </div>
    <img id="lb-img" src="" alt="Property photo">
    ${photos.length > 1 ? `
    <div class="lb-arrow" id="lb-prev" onclick="navLb(-1)">‹</div>
    <div class="lb-arrow" id="lb-next" onclick="navLb(1)">›</div>` : ''}
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