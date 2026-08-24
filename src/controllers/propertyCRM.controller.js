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
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

// ─── Helper: upload file buffer to R2 ────────────────────────────────────────
// Accepts a multer file object (req.files[i]) — buffer already in memory,
// no base64 needed so we stay within the 100kb JSON body limit.
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
    const key = url.replace(`${R2_PUBLIC_URL}/`, '');
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
        sold: { $sum: { $cond: [{ $in: ['$status', ['sold', 'rented']] }, 1, 0] } },
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
        sold: { $sum: { $cond: [{ $in: ['$status', ['sold', 'rented']] }, 1, 0] } },
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
// Uses multipart/form-data — field name: "photos" (multiple files)
// multer is applied in the route file via upload.array('photos', 10)
exports.uploadPhotos = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    const property = await Property.findOne({ _id: req.params.id, tenantId });
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });

    const files = req.files; // set by multer
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
// Body (JSON, small): { url: '...' }
exports.deletePhoto = async (req, res) => {
  try {
    const tenantId = req.user.tenantId?.toString();
    const { url } = req.body;
    const property = await Property.findOne({ _id: req.params.id, tenantId });
    if (!property) return res.status(404).json({ success: false, message: 'Not found' });
    await deleteImageFromR2(url);
    property.photos = property.photos.filter((p) => p !== url);
    await property.save();
    res.json({ success: true, photos: property.photos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
