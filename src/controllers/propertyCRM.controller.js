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

// POST /api/property-crm/properties/:id/share-link
// Generates (or refreshes) a 48-hour share token and returns the public URL.
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
const AGENT_PHONE = '7498366577'; // 10-digit, bina +91

exports.getGalleryPage = async (req, res) => {
  try {
    let property;
    if (req.params.token) {
      property = await Property.findOne({
        shareToken: req.params.token,
        shareTokenExpiry: { $gt: new Date() },
      });
      if (!property) {
        return res.status(410).send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Expired</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#f3f6fd;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{background:#fff;border-radius:20px;padding:48px 36px;text-align:center;max-width:380px;width:90%;box-shadow:0 6px 30px rgba(15,30,80,.08)}.icon{font-size:56px;margin-bottom:20px}.title{font-size:22px;font-weight:800;color:#0e1a3a;margin-bottom:10px}.sub{font-size:14px;color:#6b7690;line-height:1.6}</style></head><body><div class="card"><div class="icon">⏰</div><div class="title">Link Expired</div><div class="sub">This property link was valid for 48 hours and has expired.<br><br>Ask the agent to send you a fresh link.</div></div></body></html>`);
      }
    } else {
      property = await Property.findById(req.params.id);
      if (!property) return res.status(404).send('Property not found');
    }

    const p = property.toObject ? property.toObject() : property;
    const photos = (p.photos || []).filter(Boolean);
    const isRent = p.listingType === 'Rent';

    // ── helpers ──────────────────────────────────────────────────────────────
    const esc = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const num = (v) => {
      const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
      return isNaN(n) ? 0 : n;
    };
    const fmtPrice = (v) => {
      const n = num(v);
      if (!n) return v ? esc(v) : '';
      const trim = (x) => x.toFixed(2).replace(/\.?0+$/, '');
      if (n >= 10000000) return '₹' + trim(n / 10000000) + ' Cr';
      if (n >= 100000) return '₹' + trim(n / 100000) + ' Lakh';
      return '₹' + n.toLocaleString('en-IN');
    };
    const sqft = (v) => {
      if (!v) return '';
      const s = String(v).trim();
      return /[a-z]/i.test(s) ? esc(s) : esc(s) + ' sq.ft';
    };

    const priceMain = isRent
      ? (p.monthlyRent ? '₹' + num(p.monthlyRent).toLocaleString('en-IN') + '/mo' : fmtPrice(p.price))
      : fmtPrice(p.price);

    let perSqft = '';
    if (!isRent && num(p.price) && num(p.buildupArea)) {
      perSqft = '₹' + Math.round(num(p.price) / num(p.buildupArea)).toLocaleString('en-IN') + ' per sq.ft (Approx.)';
    }

    // ── Detail tiles (icon emoji + pastel colour) ────────────────────────────
    const details = [
      ['🏠', '#e6f0ff', 'Type', esc(p.flatConfig || p.propertyType)],
      ['📐', '#e3f7ea', 'Carpet Area', sqft(p.carpetArea)],
      ['📏', '#fff0dc', 'Built-up Area', sqft(p.buildupArea)],
      ['🏢', '#efe6ff', 'Total Floors', esc(p.totalFloors)],
      ['🧭', '#fff0dc', 'Facing', esc(p.facing)],
      ['🛗', '#efe6ff', 'Lift', esc(p.lift)],
      ['🅿️', '#ffe6ec', 'Parking', esc(p.parking)],
      ['💧', '#e3f7ea', 'Water Supply', esc(p.water)],
      ['🏬', '#fff6d6', 'Flats / Floor', esc(p.flatsOnFloor)],
      ['🛋️', '#efe6ff', 'Furnishing', esc(p.furnishing)],
      ['🗓️', '#fff0dc', 'Property Age', esc(p.propertyAge)],
      ['🔑', '#ffe6ec', 'Possession', esc(p.possession)],
      ['📜', '#e6f0ff', 'Sanction', esc(p.sanction)],
      ['🧱', '#e3f7ea', 'Floor', esc(p.floor)],
    ].filter((d) => d[3]);

    const detailsHTML = details.map((d) =>
      `<div class="dt"><div class="dt-ic" style="background:${d[1]}">${d[0]}</div><div class="dt-tx"><div class="dt-l">${d[2]}</div><div class="dt-v">${d[3]}</div></div></div>`
    ).join('');

    // ── Amenities (keyword → emoji + tint) ───────────────────────────────────
    const AM = [
      [/pool|swim/i, '🏊', '#e3f2ff'], [/gym|fitness/i, '🏋️', '#e3f7ea'],
      [/club/i, '🏡', '#efe6ff'], [/backup|power|generator/i, '⚡', '#fff6d6'],
      [/cctv|camera|surveil/i, '📹', '#ffe6ec'], [/secur|guard/i, '🛡️', '#e3f2ff'],
      [/garden|park\b|green/i, '🌿', '#e3f7ea'], [/kid|play|child/i, '🎠', '#ffe6ec'],
      [/visitor/i, '🚗', '#fff0dc'], [/lift|elevator/i, '🛗', '#efe6ff'],
      [/parking/i, '🅿️', '#fff0dc'], [/water/i, '💧', '#e3f2ff'],
      [/garbage|waste/i, '♻️', '#e3f7ea'], [/temple|pooja/i, '🛕', '#fff0dc'],
      [/jog|track/i, '🏃', '#e3f7ea'], [/court|sport|tennis|badminton/i, '🏸', '#e3f2ff'],
    ];
    const amenitiesHTML = (p.amenities || []).map((a) => {
      const m = AM.find((x) => x[0].test(a));
      return `<div class="am" style="background:${m ? m[2] : '#eef2fb'}"><div class="am-ic">${m ? m[1] : '✔️'}</div><div class="am-l">${esc(a)}</div></div>`;
    }).join('');

    // ── Gallery ──────────────────────────────────────────────────────────────
    const thumbsShown = photos.slice(0, 5);
    const extra = photos.length - 5;
    const thumbsHTML = thumbsShown.map((u, i) => {
      const more = i === 4 && extra > 0;
      return `<div class="th${i === 0 ? ' on' : ''}" data-i="${i}"><img src="${esc(u)}" alt="" loading="lazy">${more ? `<div class="th-more">+${extra}</div>` : ''}</div>`;
    }).join('');

    const galleryHTML = photos.length ? `
      <div class="hero" id="hero">
        <img id="hero-img" src="${esc(photos[0])}" alt="Property photo">
        <div class="cnt" id="cnt">1 / ${photos.length}</div>
        ${photos.length > 1 ? `<button class="ar l" id="prev" aria-label="Previous">&#8249;</button><button class="ar r" id="next" aria-label="Next">&#8250;</button>` : ''}
      </div>
      ${photos.length > 1 ? `<div class="thumbs">${thumbsHTML}</div>` : ''}`
      : `<div class="hero nophoto"><div>🏢<br><span>No photos available</span></div></div>`;

    const waText = encodeURIComponent(`Hi, I'm interested in "${p.projectName || p.society || 'your property'}"${p.location ? ' at ' + p.location : ''}. Can you share more details?`);
    const waLink = `https://wa.me/91${AGENT_PHONE}?text=${waText}`;
    const telLink = `tel:+91${AGENT_PHONE}`;
    const statusLabel = p.status === 'sold' ? 'Sold' : p.status === 'rented' ? 'Rented' : '';

    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'unsafe-inline'; font-src https://fonts.gstatic.com; connect-src 'none';");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1530">
<title>${esc(p.projectName || 'Property')} | Kin Property Management</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#0b1530;--gold:#f5c542;--blue:#1457f5;--bg:#f3f6fd;--ink:#0e1a3a;--mute:#6b7690;--line:#e6ebf5}
html{-webkit-tap-highlight-color:transparent}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink);line-height:1.4;padding-bottom:110px}
.wrap{max-width:560px;margin:0 auto}

/* header */
.top{background:var(--navy);padding:calc(env(safe-area-inset-top,0px) + 16px) 16px 14px;text-align:center}
.top h1{font-size:19px;font-weight:700;color:#fff;letter-spacing:-.2px}
.top h1 b{color:var(--gold);font-weight:700}

/* gallery */
.gal{padding:10px 10px 0}
.hero{position:relative;border-radius:22px;overflow:hidden;aspect-ratio:16/9.6;background:#d7dde9;touch-action:pan-y}
.hero img{width:100%;height:100%;object-fit:cover;display:block}
.hero.nophoto{display:flex;align-items:center;justify-content:center;text-align:center;font-size:44px;color:#9aa6bf}
.hero.nophoto span{font-size:13px;font-weight:600}
.cnt{position:absolute;top:14px;right:14px;background:rgba(20,26,45,.62);color:#fff;font-size:13px;font-weight:600;padding:6px 12px;border-radius:999px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.ar{position:absolute;top:50%;transform:translateY(-50%);width:40px;height:40px;border-radius:50%;border:0;background:#fff;color:var(--ink);font-size:28px;line-height:1;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer;padding-bottom:4px}
.ar.l{left:12px}.ar.r{right:12px}
.thumbs{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-top:10px}
.th{position:relative;aspect-ratio:1/.85;border-radius:12px;overflow:hidden;cursor:pointer;background:#d7dde9;border:2px solid transparent}
.th.on{border-color:var(--blue);box-shadow:0 0 0 2px rgba(20,87,245,.18)}
.th img{width:100%;height:100%;object-fit:cover;display:block}
.th-more{position:absolute;inset:0;background:rgba(20,26,45,.6);color:#fff;font-weight:700;font-size:16px;display:flex;align-items:center;justify-content:center}

/* title */
.title{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 14px 0}
.title h2{font-size:24px;font-weight:800;letter-spacing:-.5px;line-height:1.15}
.pill{background:#e9eef9;color:var(--ink);font-weight:600;font-size:14px;padding:9px 16px;border-radius:999px;white-space:nowrap}
.addr{padding:6px 14px 0;font-size:13px;color:var(--mute);font-weight:500}
.stat{margin:10px 14px 0;display:inline-block;background:#ffe9e9;color:#c62828;font-weight:700;font-size:12px;padding:5px 12px;border-radius:999px}

/* price */
.price{margin:14px 10px 0;border-radius:20px;padding:16px 20px 16px;background:linear-gradient(120deg,#e6edfb 0%,#dfe8fb 55%,#e9effc 100%)}
.price .l{font-size:14px;font-weight:600;color:#56627f}
.price .v{font-size:36px;font-weight:800;letter-spacing:-1px;margin-top:2px}
.price .s{font-size:15px;color:#6b7690;margin-top:4px;font-weight:500}
.price .dep{display:flex;gap:10px;margin-top:12px}
.price .dep div{flex:1;background:rgba(255,255,255,.65);border-radius:12px;padding:10px 12px}
.price .dep small{display:block;font-size:11px;color:var(--mute);font-weight:600}
.price .dep b{font-size:16px;font-weight:800}

/* cards */
.card{background:#fff;border-radius:20px;margin:12px 10px 0;padding:14px 12px 14px;box-shadow:0 2px 14px rgba(20,40,100,.05)}
.card h3{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:700;margin:0 4px 12px}
.card h3 i{font-style:normal;width:34px;height:34px;border-radius:10px;background:#fff1de;display:flex;align-items:center;justify-content:center;font-size:18px}
.dgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.dt{background:#f8faff;border:1px solid var(--line);border-radius:14px;padding:10px 8px;display:flex;align-items:center;gap:8px;min-width:0}
.dt-ic{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.dt-tx{min-width:0}
.dt-l{font-size:11.5px;color:var(--mute);font-weight:500}
.dt-v{font-size:13.5px;font-weight:700;line-height:1.2;overflow-wrap:anywhere}
.agrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.am{border-radius:12px;padding:12px 6px 10px;text-align:center;min-width:0}
.am-ic{font-size:24px;line-height:1.1}
.am-l{font-size:12.5px;font-weight:500;margin-top:6px;overflow-wrap:anywhere}
.docs{display:flex;flex-direction:column;gap:7px}
.doc{background:#f8faff;border:1px solid var(--line);border-radius:12px;padding:11px 14px;font-size:13.5px;font-weight:600}
.notes{font-size:14px;color:#374151;line-height:1.7;padding:0 4px;white-space:pre-line}
.exp{text-align:center;font-size:12px;color:var(--mute);font-weight:500;margin:14px 10px 0}

/* contact bar */
.bar{position:fixed;left:0;right:0;bottom:0;z-index:40;background:linear-gradient(to top,#fff 70%,rgba(255,255,255,0));padding:18px 14px max(14px,env(safe-area-inset-bottom,14px))}
.cta{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;max-width:560px;margin:0 auto;border:0;border-radius:16px;background:var(--blue);color:#fff;font:700 18px 'Inter',sans-serif;padding:19px 20px;box-shadow:0 8px 22px rgba(20,87,245,.32);cursor:pointer}
.cta svg{width:24px;height:24px;fill:#fff}
.cta:active{transform:scale(.985)}

/* bottom sheet */
.ov{position:fixed;inset:0;background:rgba(10,16,35,.5);opacity:0;pointer-events:none;transition:opacity .25s;z-index:60}
.ov.open{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:70;background:#fff;border-radius:24px 24px 0 0;padding:10px 18px max(22px,env(safe-area-inset-bottom,22px));transform:translateY(105%);transition:transform .3s cubic-bezier(.2,.8,.2,1);max-width:560px;margin:0 auto}
.sheet.open{transform:translateY(0)}
.grab{width:44px;height:5px;border-radius:3px;background:#d5dbe8;margin:0 auto 14px}
.sheet h4{font-size:18px;font-weight:800;text-align:center}
.sheet p{font-size:13px;color:var(--mute);text-align:center;margin:4px 0 16px}
.opt{display:flex;align-items:center;gap:14px;text-decoration:none;border-radius:16px;padding:15px 16px;margin-bottom:10px;font-weight:700;font-size:16px}
.opt small{display:block;font-weight:500;font-size:12.5px;opacity:.85;margin-top:1px}
.opt .ic{width:42px;height:42px;border-radius:12px;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.opt .ic svg{width:24px;height:24px;fill:#fff}
.opt.wa{background:#25d366;color:#fff}
.opt.call{background:var(--navy);color:#fff}
.cancel{display:block;width:100%;border:0;background:#eef2fb;color:var(--ink);font:600 15px 'Inter',sans-serif;padding:14px;border-radius:14px;margin-top:2px;cursor:pointer}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><h1>Kin <b>Property</b> Management</h1></div>

  <div class="gal">${galleryHTML}</div>

  <div class="title">
    <h2>${esc(p.projectName || p.society || '')}</h2>
    ${(p.flatConfig || p.bhk) ? `<div class="pill">${esc(p.flatConfig || p.bhk)}</div>` : ''}
  </div>
  ${(p.address || p.location) ? `<div class="addr">📍 ${esc([p.address, p.location].filter(Boolean).join(', '))}${p.nearbyLocalities ? ' · Near ' + esc(p.nearbyLocalities) : ''}</div>` : ''}
  ${statusLabel ? `<div class="stat">${statusLabel}</div>` : ''}

  <div class="price">
    <div class="l">${isRent ? 'MONTHLY RENT' : 'SALE PRICE'}</div>
    <div class="v">${priceMain || '—'}</div>
    ${perSqft ? `<div class="s">${perSqft}</div>` : ''}
    ${p.maintenance ? `<div class="s">+ ₹${esc(p.maintenance)}/mo maintenance</div>` : ''}
    ${isRent && p.securityDeposit ? `<div class="dep"><div><small>Security Deposit</small><b>₹${num(p.securityDeposit).toLocaleString('en-IN')}</b></div></div>` : ''}
  </div>

  ${detailsHTML ? `<div class="card"><h3><i>🏠</i>Property Details</h3><div class="dgrid">${detailsHTML}</div></div>` : ''}

  ${amenitiesHTML ? `<div class="card"><h3><i>🏰</i>Amenities</h3><div class="agrid">${amenitiesHTML}</div></div>` : ''}

  ${(p.documents && p.documents.length) ? `<div class="card"><h3><i>📄</i>Documents Available</h3><div class="docs">${p.documents.map((d) => `<div class="doc">✔ ${esc(d)}</div>`).join('')}</div></div>` : ''}

  ${p.notes ? `<div class="card"><h3><i>📝</i>Additional Info</h3><div class="notes">${esc(p.notes)}</div></div>` : ''}

  ${req.params.token ? `<div class="exp">🕐 This link is valid for 48 hours</div>` : ''}
</div>

<!-- Contact bar -->
<div class="bar">
  <button class="cta" id="open-contact" type="button">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4.2"/><path d="M4 21c0-4.2 3.6-7 8-7s8 2.8 8 7z"/></svg>
    Contact Agent
  </button>
</div>

<div class="ov" id="ov"></div>
<div class="sheet" id="sheet" role="dialog" aria-label="Contact agent">
  <div class="grab"></div>
  <h4>Contact Agent</h4>
  <p>Kin Property Management</p>
  <a class="opt wa" href="${waLink}" target="_blank" rel="noopener">
    <span class="ic"><svg viewBox="0 0 24 24"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.39-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35zM12 21.8a9.8 9.8 0 01-5-1.37l-.36-.21-3.71.97.99-3.6-.23-.37A9.8 9.8 0 1112 21.8zM12 0C5.37 0 0 5.37 0 12c0 2.12.55 4.12 1.53 5.86L0 24l6.3-1.65A12 12 0 1012 0z"/></svg></span>
    <span>Chat on WhatsApp<small>+91 ${AGENT_PHONE}</small></span>
  </a>
  <a class="opt call" href="${telLink}">
    <span class="ic"><svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 006.6 6.6l2.2-2.2a1 1 0 011-.25 11.4 11.4 0 003.6.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1z"/></svg></span>
    <span>Call Now<small>+91 ${AGENT_PHONE}</small></span>
  </a>
  <button class="cancel" id="close-contact" type="button">Cancel</button>
</div>

<script>
(function(){
  var PHOTOS = ${JSON.stringify(photos).replace(/</g, '\\u003c')};
  var cur = 0;
  var img = document.getElementById('hero-img');
  var cnt = document.getElementById('cnt');
  var thumbs = document.querySelectorAll('.th');

  function show(i){
    if(!PHOTOS.length) return;
    cur = (i + PHOTOS.length) % PHOTOS.length;
    img.src = PHOTOS[cur];
    cnt.textContent = (cur + 1) + ' / ' + PHOTOS.length;
    for(var k = 0; k < thumbs.length; k++){
      thumbs[k].classList.toggle('on', parseInt(thumbs[k].getAttribute('data-i'), 10) === cur);
    }
  }
  var prev = document.getElementById('prev');
  var next = document.getElementById('next');
  if(prev) prev.addEventListener('click', function(){ show(cur - 1); });
  if(next) next.addEventListener('click', function(){ show(cur + 1); });
  for(var t = 0; t < thumbs.length; t++){
    thumbs[t].addEventListener('click', function(){
      show(parseInt(this.getAttribute('data-i'), 10));
    });
  }
  // swipe on hero
  var hero = document.getElementById('hero'), sx = 0;
  if(hero && PHOTOS.length > 1){
    hero.addEventListener('touchstart', function(e){ sx = e.touches[0].clientX; }, {passive:true});
    hero.addEventListener('touchend', function(e){
      var dx = e.changedTouches[0].clientX - sx;
      if(Math.abs(dx) > 40) show(dx < 0 ? cur + 1 : cur - 1);
    });
  }

  // contact sheet
  var ov = document.getElementById('ov'), sheet = document.getElementById('sheet');
  function openS(){ ov.classList.add('open'); sheet.classList.add('open'); }
  function closeS(){ ov.classList.remove('open'); sheet.classList.remove('open'); }
  document.getElementById('open-contact').addEventListener('click', openS);
  document.getElementById('close-contact').addEventListener('click', closeS);
  ov.addEventListener('click', closeS);
})();
</script>
</body>
</html>`);
  } catch (err) {
    console.error('[getGalleryPage]', err);
    res.status(500).send('Something went wrong loading this property page.');
  }
};


// ─── EXPORT CSV ───────────────────────────────────────────────────────────────

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