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
async function uploadBufferToR2(file, tenantId) {
  const ext = (file.mimetype.split('/')[1] || 'jpg').split('+')[0];
  const key = `properties/${tenantId}/${crypto.randomUUID()}.${ext}`;
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
    const tenantId = req.user.tenantId?.toString();
    const { category } = req.query;
    const filter = { tenantId, isActive: true };
    if (category) filter.category = category;
    const items = await PropertyMasterData.find(filter).sort({ value: 1 }).lean();
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.addMasterData = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    const { category, value } = req.body;
    if (!category || !value) return res.status(400).json({ success: false, message: 'category and value required' });
    const item = await PropertyMasterData.findOneAndUpdate(
      { tenantId, category, value },
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
    const tenantId = req.user.tenantId?.toString();
    await PropertyMasterData.findOneAndUpdate({ _id: req.params.id, tenantId }, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── DASHBOARD STATS ──────────────────────────────────────────────────────────

exports.getStats = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    const [total, available, sold] = await Promise.all([
      Property.countDocuments({ tenantId }),
      Property.countDocuments({ tenantId, status: 'available' }),
      Property.countDocuments({ tenantId, status: { $in: ['sold', 'rented'] } }),
    ]);
    res.json({ success: true, total, available, sold });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── EXPLORE ──────────────────────────────────────────────────────────────────

exports.getLocationsSummary = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    const agg = await Property.aggregate([
      { $match: { tenantId } },
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
    const tenantId = req.user.tenantId?.toString();
    const filter = { tenantId };
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
    const tenantId = req.user.tenantId?.toString();
    const filter = { tenantId };
    if (req.query.location) filter.location = req.query.location;
    if (req.query.propertyType) filter.propertyType = req.query.propertyType;
    if (req.query.status) filter.status = req.query.status;
    const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ success: true, properties });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getPropertyById = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    const property = await Property.findOne({ _id: req.params.id, tenantId }).lean();
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, property });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.createProperty = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    const {
      projectName, intent, propertyType, carpetArea, buildupArea,
      location, address, price, amenities, parking, notes,
      ownerName, ownerPhone,
    } = req.body;
    if (!projectName || !intent || !propertyType || !location) {
      return res.status(400).json({ success: false, message: 'projectName, intent, propertyType, location required' });
    }
    const property = await Property.create({
      tenantId, projectName, intent, propertyType, carpetArea, buildupArea,
      location, address, price, amenities, parking, notes,
      ownerName, ownerPhone, createdBy: req.user._id,
    });
    res.status(201).json({ success: true, property });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateProperty = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    const property = await Property.findOneAndUpdate(
      { _id: req.params.id, tenantId },
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
    const tenantId = req.user.tenantId?.toString();
    const property = await Property.findOne({ _id: req.params.id, tenantId });
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
    const tenantId = req.user.tenantId?.toString();
    const { status } = req.body;
    if (!['available', 'sold', 'rented'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const update = { status };
    if (status !== 'available') update.soldOrRentedAt = new Date();
    const property = await Property.findOneAndUpdate(
      { _id: req.params.id, tenantId },
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
    const tenantId = req.user.tenantId?.toString();
    const property = await Property.findOne({ _id: req.params.id, tenantId });
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });

    const files = req.files;
    if (!files || !files.length) {
      return res.status(400).json({ success: false, message: 'No photos provided' });
    }

    const urls = await Promise.all(files.map((f) => uploadBufferToR2(f, tenantId)));
    property.photos.push(...urls);
    await property.save();
    res.json({ success: true, photos: property.photos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/property-crm/properties/:id/photos
// Body: { url: '...' }
exports.deletePhoto = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    // Support both JSON body and query param as fallback
    const url = req.body?.url || req.query?.url;
    if (!url) return res.status(400).json({ success: false, message: 'url is required' });

    const property = await Property.findOne({ _id: req.params.id, tenantId });
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
exports.getGalleryPage = async (req, res) => {
  try {
    const property = await Property.findById(req.params.id).select('projectName photos location propertyType price');
    if (!property) return res.status(404).send('Property not found');

    if (!property.photos?.length) {
      return res.send(`<!DOCTYPE html>
<html><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${property.projectName}</title>
  <style>body{margin:0;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;}</style>
</head><body><div><div style="font-size:48px">🏠</div><p>No photos uploaded yet</p></div></body></html>`);
    }

    const photoTags = property.photos
      .map(url => `
        <div class="photo-wrap">
          <img src="${url}" alt="${property.projectName}" loading="lazy">
        </div>`)
      .join('');

    // Set permissive CSP so R2/Cloudflare images load correctly
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; img-src *; style-src 'unsafe-inline'; script-src 'unsafe-inline';"
    );

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta charset="utf-8">
  <title>${property.projectName} — Photos</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f0f; font-family: -apple-system, sans-serif; color: #fff; }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      padding: 20px 16px 16px;
      border-bottom: 1px solid #333;
      position: sticky; top: 0; z-index: 10;
    }
    .brand { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 4px; }
    .title { font-size: 20px; font-weight: 700; color: #fff; }
    .meta { font-size: 13px; color: #aaa; margin-top: 4px; }
    .count { font-size: 12px; color: #666; margin-top: 8px; }
    .grid { padding: 12px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    @media(min-width:500px){ .grid { grid-template-columns: repeat(3, 1fr); } }
    .photo-wrap { aspect-ratio: 1; overflow: hidden; border-radius: 10px; background: #1a1a1a; }
    img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: pointer; transition: opacity 0.2s; }
    img:hover { opacity: 0.9; }
    /* Lightbox */
    #lb { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.95); z-index:100; align-items:center; justify-content:center; }
    #lb.open { display:flex; }
    #lb img { max-width:95vw; max-height:90vh; object-fit:contain; border-radius:6px; }
    #lb-close { position:fixed; top:16px; right:16px; font-size:28px; color:#fff; cursor:pointer; background:rgba(0,0,0,0.5); border-radius:50%; width:40px; height:40px; display:flex; align-items:center; justify-content:center; }
    .footer { text-align:center; padding:24px 16px; color:#444; font-size:12px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">🏢 Kin Property Management</div>
    <div class="title">${property.projectName}</div>
    <div class="meta">${property.propertyType || ''}${property.location ? ' · ' + property.location : ''}${property.price ? ' · ₹' + property.price : ''}</div>
    <div class="count">${property.photos.length} photo${property.photos.length !== 1 ? 's' : ''}</div>
  </div>
  <div class="grid">${photoTags}</div>
  <div class="footer">Shared via Kin Property Management</div>

  <!-- Lightbox -->
  <div id="lb"><div id="lb-close">✕</div><img id="lb-img" src="" alt=""></div>
  <script>
    var lb = document.getElementById('lb');
    var lbImg = document.getElementById('lb-img');
    document.querySelectorAll('.photo-wrap img').forEach(function(img){
      img.addEventListener('click', function(){ lbImg.src=this.src; lb.classList.add('open'); });
    });
    document.getElementById('lb-close').addEventListener('click', function(){ lb.classList.remove('open'); });
    lb.addEventListener('click', function(e){ if(e.target===lb) lb.classList.remove('open'); });
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error loading gallery');
  }
};
