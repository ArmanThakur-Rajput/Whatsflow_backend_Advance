const Property = require('../models/Property.model');
const PropertyMasterData = require('../models/PropertyMasterData.model');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
//
// The page itself is a React + TypeScript app, pre-built into
// propertyShare.template.html (same folder as this controller). The server only
// prepares the property data and injects it as JSON into the template.
const AGENT_PHONE = '7498366577'; // 10-digit, bina +91
const SHARE_TEMPLATE_PATH = path.join(__dirname, 'propertyShare.template.html');
let shareTemplateCache = null;
const getShareTemplate = () => {
  if (!shareTemplateCache) shareTemplateCache = fs.readFileSync(SHARE_TEMPLATE_PATH, 'utf8');
  return shareTemplateCache;
};

const EXPIRED_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Expired</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#f3f6fd;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.card{background:#fff;border-radius:20px;padding:48px 36px;text-align:center;max-width:380px;width:90%;box-shadow:0 6px 30px rgba(15,30,80,.08)}.icon{margin-bottom:20px}.icon svg{width:56px;height:56px;fill:none;stroke:#1457f5;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.title{font-size:22px;font-weight:800;color:#0e1a3a;margin-bottom:10px}.sub{font-size:14px;color:#6b7690;line-height:1.6}</style></head><body><div class="card"><div class="icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div><div class="title">Link Expired</div><div class="sub">This property link was valid for 48 hours and has expired.<br><br>Ask the agent to send you a fresh link.</div></div></body></html>`;

const escHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const toNum = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
};
const fmtPrice = (v) => {
  const n = toNum(v);
  if (!n) return v ? String(v) : '';
  const trim = (x) => x.toFixed(2).replace(/\.?0+$/, '');
  if (n >= 10000000) return '₹' + trim(n / 10000000) + ' Cr';
  if (n >= 100000) return '₹' + trim(n / 100000) + ' Lakh';
  return '₹' + n.toLocaleString('en-IN');
};
const fmtSqft = (v) => {
  if (!v) return '';
  const s = String(v).trim();
  return /[a-z]/i.test(s) ? s : s + ' sq.ft';
};

function buildSharePayload(p, isShareLink) {
  const isRent = p.listingType === 'Rent';
  const priceMain = isRent
    ? (p.monthlyRent ? '₹' + toNum(p.monthlyRent).toLocaleString('en-IN') + '/mo' : fmtPrice(p.price))
    : fmtPrice(p.price);
  let perSqft = '';
  if (!isRent && toNum(p.price) && toNum(p.buildupArea)) {
    perSqft = '₹' + Math.round(toNum(p.price) / toNum(p.buildupArea)).toLocaleString('en-IN') + ' per sq.ft (Approx.)';
  }
  // [icon key, label, value]
  const details = [
    ['home', 'Type', p.flatConfig || p.bhk || p.propertyType],
    ['ruler', 'Carpet Area', fmtSqft(p.carpetArea)],
    ['expand', 'Built-up Area', fmtSqft(p.buildupArea)],
    ['building', 'Total Floors', p.totalFloors],
    ['compass', 'Facing', p.facing],
    ['lift', 'Lift', p.lift],
    ['parking', 'Parking', p.parking],
    ['drop', 'Water Supply', p.water],
    ['grid', 'Flats / Floor', p.flatsOnFloor],
    ['sofa', 'Furnishing', p.furnishing],
    ['calendar', 'Property Age', p.propertyAge],
    ['key', 'Possession', p.possession],
    ['filecheck', 'Sanction', p.sanction],
    ['layers', 'Floor', p.floor],
  ].filter((d) => d[2] != null && String(d[2]).trim() !== '').map((d) => [d[0], d[1], String(d[2])]);

  const address = [p.address, p.location].filter(Boolean).join(', ')
    + (p.nearbyLocalities ? ' · Near ' + p.nearbyLocalities : '');

  return {
    projectName: p.projectName || p.society || '',
    flatConfig: p.flatConfig || p.bhk || '',
    address,
    statusLabel: p.status === 'sold' ? 'Sold' : p.status === 'rented' ? 'Rented' : '',
    priceLabel: isRent ? 'MONTHLY RENT' : 'SALE PRICE',
    priceMain,
    perSqft,
    maintenance: p.maintenance ? String(p.maintenance) : '',
    deposit: isRent && p.securityDeposit ? '₹' + toNum(p.securityDeposit).toLocaleString('en-IN') : '',
    details,
    amenities: (p.amenities || []).filter(Boolean).map(String),
    photos: (p.photos || []).filter(Boolean),
    documents: (p.documents || []).filter(Boolean).map(String),
    notes: p.notes ? String(p.notes) : '',
    expiring: !!isShareLink,
    agentPhone: AGENT_PHONE,
  };
}

exports.getGalleryPage = async (req, res) => {
  try {
    let property;
    if (req.params.token) {
      property = await Property.findOne({
        shareToken: req.params.token,
        shareTokenExpiry: { $gt: new Date() },
      });
      if (!property) return res.status(410).send(EXPIRED_PAGE);
    } else {
      property = await Property.findById(req.params.id);
      if (!property) return res.status(404).send('Property not found');
    }

    const p = property.toObject ? property.toObject() : property;
    const payload = buildSharePayload(p, !!req.params.token);

    // JSON is injected inside a <script>, so escape anything that could close it.
    const json = JSON.stringify(payload)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

    // split/join (not String.replace) so "$" in data is never treated as a pattern
    const html = getShareTemplate()
      .split('__TITLE__').join(escHtml(payload.projectName || 'Property'))
      .split('__PROPERTY_JSON__').join(json);

    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'unsafe-inline'; font-src https://fonts.gstatic.com; connect-src 'none';");
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(html);
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