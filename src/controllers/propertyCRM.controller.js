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
    const property = await Property.findById(req.params.id).select('projectName photos location propertyType price status intent');
    if (!property) return res.status(404).send('Property not found');

    if (!property.photos?.length) {
      return res.send(`<!DOCTYPE html>
<html><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${property.projectName}</title>
  <style>body{margin:0;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;}</style>
</head><body><div><div style="font-size:48px">🏠</div><p>No photos uploaded yet</p></div></body></html>`);
    }

    const statusColor = property.status === 'available' ? '#22c55e' : property.status === 'sold' ? '#ef4444' : '#f59e0b';
    const statusLabel = property.status === 'available' ? 'Available' : property.status === 'sold' ? 'Sold' : 'Rented';
    const intentLabel = property.intent === 'buy' ? 'For Sale' : 'For Rent';

    // First photo is hero, rest go in grid
    const [heroPhoto, ...gridPhotos] = property.photos;

    const heroTag = `<div class="hero-wrap"><img class="hero-img" src="${heroPhoto}" alt="${property.projectName}" loading="eager" data-index="0"><div class="hero-badge">${property.photos.length} Photos</div></div>`;

    const gridTags = gridPhotos.map((url, i) => `
      <div class="thumb-wrap">
        <img src="${url}" alt="${property.projectName}" loading="lazy" data-index="${i + 1}">
      </div>`).join('');

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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f0f; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #fff; min-height: 100vh; }

    /* ── Header ── */
    .header {
      background: linear-gradient(160deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%);
      padding: 20px 16px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .brand { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; }
    .title { font-size: 24px; font-weight: 800; color: #fff; line-height: 1.2; margin-bottom: 6px; }
    .meta-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
    .badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600;
    }
    .badge-status { background: ${statusColor}22; color: ${statusColor}; border: 1px solid ${statusColor}44; }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: ${statusColor}; }
    .badge-type { background: rgba(255,255,255,0.08); color: #d1d5db; }
    .badge-intent { background: rgba(99,102,241,0.15); color: #a5b4fc; }
    .price { font-size: 22px; font-weight: 800; color: #6366f1; margin-top: 10px; }
    .location { font-size: 13px; color: #9ca3af; margin-top: 6px; display: flex; align-items: center; gap: 4px; }

    /* ── Hero ── */
    .hero-wrap { position: relative; width: 100%; aspect-ratio: 16/9; max-height: 320px; overflow: hidden; cursor: pointer; }
    .hero-img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.3s ease; }
    .hero-wrap:active .hero-img { transform: scale(0.98); }
    .hero-badge {
      position: absolute; bottom: 12px; right: 12px;
      background: rgba(0,0,0,0.7); backdrop-filter: blur(8px);
      color: #fff; font-size: 12px; font-weight: 600;
      padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.15);
    }
    .tap-hint {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0); transition: background 0.2s;
      pointer-events: none;
    }
    .tap-hint-icon {
      background: rgba(0,0,0,0.5); border-radius: 50%; width: 48px; height: 48px;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.2s;
      font-size: 20px;
    }
    .hero-wrap:hover .tap-hint { background: rgba(0,0,0,0.2); }
    .hero-wrap:hover .tap-hint-icon { opacity: 1; }

    /* ── Grid ── */
    .section-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 1.5px; padding: 16px 16px 8px; font-weight: 600; }
    .grid { padding: 0 12px 12px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    @media(min-width: 500px) { .grid { grid-template-columns: repeat(4, 1fr); } }
    .thumb-wrap { aspect-ratio: 1; overflow: hidden; border-radius: 8px; background: #1a1a1a; cursor: pointer; }
    .thumb-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.2s, opacity 0.2s; }
    .thumb-wrap:active img { transform: scale(0.95); opacity: 0.8; }

    /* ── Lightbox ── */
    #lb {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.97);
      z-index: 999;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      touch-action: pan-y pinch-zoom;
    }
    #lb.open { display: flex; }

    .lb-topbar {
      position: fixed; top: 0; left: 0; right: 0;
      padding: 14px 16px;
      display: flex; align-items: center; justify-content: space-between;
      background: linear-gradient(to bottom, rgba(0,0,0,0.8), transparent);
      z-index: 10;
    }
    .lb-counter { font-size: 14px; color: #d1d5db; font-weight: 600; }
    .lb-close {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 18px; color: #fff;
      transition: background 0.2s;
    }
    .lb-close:hover { background: rgba(255,255,255,0.25); }

    .lb-img-wrap { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding: 60px 0; }
    #lb-img { max-width: 96vw; max-height: 80vh; object-fit: contain; border-radius: 8px; user-select: none; -webkit-user-drag: none; }

    .lb-nav {
      position: fixed; top: 50%; transform: translateY(-50%);
      width: 40px; height: 40px; border-radius: 50%;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 18px; color: #fff;
      transition: background 0.2s; z-index: 10;
    }
    .lb-nav:hover { background: rgba(255,255,255,0.25); }
    #lb-prev { left: 10px; }
    #lb-next { right: 10px; }

    /* Thumbnails strip at bottom */
    .lb-thumbs {
      position: fixed; bottom: 0; left: 0; right: 0;
      padding: 12px 12px 20px;
      background: linear-gradient(to top, rgba(0,0,0,0.9), transparent);
      display: flex; gap: 6px; overflow-x: auto; justify-content: center;
      scrollbar-width: none;
    }
    .lb-thumbs::-webkit-scrollbar { display: none; }
    .lb-thumb {
      width: 48px; height: 48px; flex-shrink: 0; border-radius: 6px; overflow: hidden;
      border: 2px solid transparent; cursor: pointer; transition: border-color 0.2s, opacity 0.2s;
      opacity: 0.5;
    }
    .lb-thumb.active { border-color: #6366f1; opacity: 1; }
    .lb-thumb img { width: 100%; height: 100%; object-fit: cover; }

    /* ── Footer ── */
    .footer { text-align: center; padding: 28px 16px 40px; color: #374151; font-size: 12px; }
    .footer span { color: #6366f1; }
  </style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <div class="brand">🏢 <span style="color:#ffffff">Kin Property</span> <span style="color:#f5c518">Management</span></div>
    <div class="title">${property.projectName}</div>
    ${property.location ? `<div class="location">📍 ${property.location}</div>` : ''}
    <div class="meta-row">
      <span class="badge badge-status"><span class="badge-dot"></span>${statusLabel}</span>
      ${property.propertyType ? `<span class="badge badge-type">${property.propertyType}</span>` : ''}
      <span class="badge badge-intent">${intentLabel}</span>
    </div>
    ${property.price ? `<div class="price">₹ ${property.price}</div>` : ''}
  </div>

  <!-- Hero Photo -->
  ${heroTag}

  <!-- Grid -->
  ${gridPhotos.length > 0 ? `<div class="section-label">All Photos</div><div class="grid">${gridTags}</div>` : ''}

  <!-- Footer -->
  <div class="footer">Shared via <span style="color:#ffffff">Kin Property</span> <span style="color:#f5c518">Management</span></div>

  <!-- Lightbox -->
  <div id="lb">
    <div class="lb-topbar">
      <span class="lb-counter" id="lb-counter">1 / ${property.photos.length}</span>
      <div class="lb-close" id="lb-close">✕</div>
    </div>
    <div class="lb-img-wrap">
      <img id="lb-img" src="" alt="">
    </div>
    <div class="lb-nav" id="lb-prev">‹</div>
    <div class="lb-nav" id="lb-next">›</div>
    <div class="lb-thumbs" id="lb-thumbs"></div>
  </div>

  <script>
    var photos = ${JSON.stringify(property.photos)};
    var current = 0;
    var lb = document.getElementById('lb');
    var lbImg = document.getElementById('lb-img');
    var lbCounter = document.getElementById('lb-counter');
    var lbThumbs = document.getElementById('lb-thumbs');

    // Build thumbnail strip
    photos.forEach(function(url, i) {
      var t = document.createElement('div');
      t.className = 'lb-thumb' + (i === 0 ? ' active' : '');
      t.innerHTML = '<img src="' + url + '" loading="lazy">';
      t.addEventListener('click', function() { goTo(i); });
      lbThumbs.appendChild(t);
    });

    function goTo(index) {
      current = (index + photos.length) % photos.length;
      lbImg.src = photos[current];
      lbCounter.textContent = (current + 1) + ' / ' + photos.length;
      document.querySelectorAll('.lb-thumb').forEach(function(t, i) {
        t.classList.toggle('active', i === current);
      });
      // Scroll thumb into view
      var thumbs = document.querySelectorAll('.lb-thumb');
      if (thumbs[current]) thumbs[current].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }

    function openLightbox(index) {
      lb.classList.add('open');
      document.body.style.overflow = 'hidden';
      goTo(index);
    }

    function closeLightbox() {
      lb.classList.remove('open');
      document.body.style.overflow = '';
    }

    // Click on hero
    document.querySelector('.hero-img').addEventListener('click', function() {
      openLightbox(parseInt(this.dataset.index));
    });

    // Click on grid thumbs
    document.querySelectorAll('.thumb-wrap img').forEach(function(img) {
      img.addEventListener('click', function() {
        openLightbox(parseInt(this.dataset.index));
      });
    });

    document.getElementById('lb-close').addEventListener('click', closeLightbox);
    document.getElementById('lb-prev').addEventListener('click', function() { goTo(current - 1); });
    document.getElementById('lb-next').addEventListener('click', function() { goTo(current + 1); });

    // Click outside image closes
    lb.addEventListener('click', function(e) {
      if (e.target === lb || e.target.classList.contains('lb-img-wrap')) closeLightbox();
    });

    // Keyboard navigation
    document.addEventListener('keydown', function(e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'ArrowRight') goTo(current + 1);
      if (e.key === 'ArrowLeft') goTo(current - 1);
      if (e.key === 'Escape') closeLightbox();
    });

    // Touch swipe support
    var touchStartX = 0;
    var touchStartY = 0;
    lbImg.addEventListener('touchstart', function(e) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });
    lbImg.addEventListener('touchend', function(e) {
      var dx = e.changedTouches[0].clientX - touchStartX;
      var dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
        if (dx < 0) goTo(current + 1);
        else goTo(current - 1);
      }
    }, { passive: true });
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error loading gallery');
  }
};
