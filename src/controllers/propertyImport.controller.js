const Property = require('../models/Property.model');
const asyncHandler = require('../utils/asyncHandler');
const { parse } = require('csv-parse/sync');

// Only these fields are required to import a property. Every other schema field is optional.
const REQUIRED_COLUMNS = ['projectName', 'propertyType', 'location', 'price', 'floor', 'sanction', 'parking', 'water'];
const PROPERTY_TYPES = ['1RK', '1BHK', '2BHK', '3BHK', '4BHK+', 'Bunglow', 'Plot', 'Commercial'];
const SANCTION_VALUES = ['Yes', 'No'];
const PARKING_VALUES = ['Open', 'Covered', 'None'];
const WATER_VALUES = ['Municipal Corporation', 'Gram Panchayat', 'Tanker', 'Boring'];
const EXPORT_FIELDS = [
  '_id', 'tenantId', 'projectName', 'society', 'intent', 'propertyType', 'flatConfig', 'location', 'address',
  'price', 'floor', 'carpetArea', 'buildupArea', 'buildingArea', 'flatsOnFloor', 'plotArea',
  'sanction', 'parking', 'water', 'lift', 'wings', 'facing', 'amenities', 'ownerName',
  'ownerPhone', 'tenantPhone', 'gmapsLink', 'notes', 'photos', 'status', 'soldOrRentedAt',
  'sessionId', 'createdBy', 'createdAt', 'updatedAt',
];
const LABELS = {
  _id: '_id', tenantId: 'tenantId', projectName: 'projectName', society: 'society', intent: 'intent', propertyType: 'propertyType',
  flatConfig: 'flatConfig', location: 'location', address: 'address', price: 'price', floor: 'floor',
  carpetArea: 'carpetArea', buildupArea: 'buildupArea', buildingArea: 'buildingArea', flatsOnFloor: 'flatsOnFloor',
  plotArea: 'plotArea', sanction: 'sanction', parking: 'parking', water: 'water', lift: 'lift', wings: 'wings',
  facing: 'facing', amenities: 'amenities', ownerName: 'ownerName', ownerPhone: 'ownerPhone', tenantPhone: 'tenantPhone',
  gmapsLink: 'gmapsLink', notes: 'notes', photos: 'photos', status: 'status', soldOrRentedAt: 'soldOrRentedAt',
  sessionId: 'sessionId', createdBy: 'createdBy', createdAt: 'createdAt', updatedAt: 'updatedAt',
};

function csvCell(value) {
  let str = '';
  if (value == null) str = '';
  else if (Array.isArray(value)) str = value.map((v) => v == null ? '' : String(v)).join('; ');
  else if (value instanceof Date) str = value.toISOString();
  else if (typeof value === 'object' && (value._bsontype || value.constructor?.name === 'ObjectId')) str = String(value);
  else if (typeof value === 'object') str = JSON.stringify(value);
  else str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function propertiesToCsv(properties) {
  const header = EXPORT_FIELDS.map((f) => LABELS[f] || f).join(',');
  const rows = properties.map((p) => EXPORT_FIELDS.map((field) => csvCell(p[field])).join(','));
  return [header, ...rows].join('\r\n');
}

// GET /api/property-crm/import/template
exports.downloadPropertyTemplate = asyncHandler(async (_req, res) => {
  // Keep the template focused on the fields the app actually requires. Optional columns may be added by users.
  const example = {
    projectName: 'Sunrise Heights', propertyType: '2BHK', location: 'Baner, Pune', price: '4500000',
    floor: '3', sanction: 'Yes', parking: 'Covered', water: 'Municipal Corporation',
  };
  const csv = [REQUIRED_COLUMNS.join(','), REQUIRED_COLUMNS.map((field) => csvCell(example[field])).join(',')].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="properties_template.csv"');
  res.send('\uFEFF' + csv);
});

// POST /api/property-crm/import
exports.importProperties = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No CSV file uploaded' });

  let rows;
  try {
    rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: false });
  } catch (e) {
    return res.status(400).json({ message: `Invalid CSV file: ${e.message}` });
  }
  if (!rows.length) return res.status(400).json({ message: 'CSV is empty — no data rows found' });

  // Allow legacy CSVs using society as projectName, but do not require optional columns.
  rows = rows.map((original) => {
    const row = { ...original };
    if (!row.projectName && row.society) row.projectName = row.society;
    return row;
  });
  const uploadedColumns = Object.keys(rows[0]);
  const missing = REQUIRED_COLUMNS.filter((column) => !uploadedColumns.includes(column));
  if (missing.length) {
    return res.status(400).json({ message: `Missing required CSV columns: ${missing.join(', ')}. Download the latest properties template.` });
  }

  const errors = [];
  const created = [];
  const adminId = req.user?._id;
  const optionalStringFields = [
    'society', 'flatConfig', 'address', 'carpetArea', 'buildupArea', 'buildingArea', 'flatsOnFloor',
    'plotArea', 'wings', 'facing', 'ownerName', 'ownerPhone', 'tenantPhone', 'gmapsLink', 'notes', 'sessionId',
  ];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    if (Object.values(row).every((v) => !String(v ?? '').trim())) continue;
    const get = (key) => String(row[key] ?? '').trim();

    const missingValue = REQUIRED_COLUMNS.filter((key) => !get(key));
    if (missingValue.length) {
      errors.push({ row: rowNum, name: get('projectName') || undefined, reason: `Missing required values: ${missingValue.join(', ')}` });
      continue;
    }

    const submittedType = get('propertyType');
    const legacyType = submittedType.toLowerCase() === 'flat' && get('flatConfig') ? get('flatConfig') : submittedType.toLowerCase() === 'shop' ? 'Commercial' : submittedType;
    const propertyType = PROPERTY_TYPES.find((v) => v.toLowerCase() === legacyType.toLowerCase());
    if (!propertyType) {
      errors.push({ row: rowNum, name: get('projectName'), reason: `propertyType must be one of: ${PROPERTY_TYPES.join(', ')}` });
      continue;
    }
    const sanction = SANCTION_VALUES.find((v) => v.toLowerCase() === get('sanction').toLowerCase());
    const parking = PARKING_VALUES.find((v) => v.toLowerCase() === get('parking').toLowerCase());
    const water = WATER_VALUES.find((v) => v.toLowerCase() === get('water').toLowerCase());
    if (!sanction || !parking || !water) {
      errors.push({ row: rowNum, name: get('projectName'), reason: `sanction must be Yes/No; parking must be ${PARKING_VALUES.join('/')}; water must be ${WATER_VALUES.join('/')}` });
      continue;
    }
    const intentRaw = get('intent').toLowerCase();
    const intent = intentRaw || 'buy';
    if (!['rent', 'buy'].includes(intent)) {
      errors.push({ row: rowNum, name: get('projectName'), reason: 'intent must be rent or buy when provided' });
      continue;
    }
    const statusRaw = get('status').toLowerCase();
    const status = !statusRaw || statusRaw === 'complete' ? 'available' : statusRaw;
    if (!['available', 'sold', 'rented'].includes(status)) {
      errors.push({ row: rowNum, name: get('projectName'), reason: 'status must be available, sold, or rented' });
      continue;
    }

    const projectName = get('projectName');
    const location = get('location');
    const existing = await Property.findOne({
      projectName: { $regex: `^${projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      location: { $regex: `^${location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      propertyType,
    }).select('_id');
    if (existing) {
      errors.push({ row: rowNum, name: projectName, reason: 'Duplicate — same project name, location and property type already exists' });
      continue;
    }

    const doc = {
      projectName, intent, propertyType, location, price: get('price'), floor: get('floor'), sanction, parking, water,
      status, createdBy: adminId,
    };
    for (const field of optionalStringFields) if (get(field)) doc[field] = get(field);
    if (get('amenities')) doc.amenities = get('amenities').split(';').map((v) => v.trim()).filter(Boolean);
    if (get('photos')) doc.photos = get('photos').split(';').map((v) => v.trim()).filter(Boolean);
    if (get('soldOrRentedAt')) {
      const date = new Date(get('soldOrRentedAt'));
      if (!Number.isNaN(date.getTime())) doc.soldOrRentedAt = date;
    }

    try {
      const prop = await Property.create(doc);
      created.push(String(prop._id));
    } catch (e) {
      errors.push({ row: rowNum, name: projectName, reason: `Failed to create: ${e.message}` });
    }
  }

  return res.status(200).json({
    message: 'Import complete',
    summary: { total: rows.length, imported: created.length, skipped: errors.length, errors },
  });
});

// GET /api/property-crm/export — export all schema fields, including optional fields and photos.
exports.exportProperties = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.propertyType) filter.propertyType = req.query.propertyType;
  if (req.query.location) filter.location = req.query.location;
  if (req.query.dateFrom || req.query.dateTo) {
    filter.createdAt = {};
    if (req.query.dateFrom) filter.createdAt.$gte = new Date(`${req.query.dateFrom}T00:00:00.000Z`);
    if (req.query.dateTo) filter.createdAt.$lte = new Date(`${req.query.dateTo}T23:59:59.999Z`);
  }
  const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();
  const csv = propertiesToCsv(properties);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="properties_export.csv"');
  res.send('\uFEFF' + csv);
});

// Shared helper for the properties list screen export endpoint.
exports.exportCSV = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.propertyType) filter.propertyType = req.query.propertyType;
  if (req.query.location) filter.location = req.query.location;
  const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="properties.csv"');
  res.send('\uFEFF' + propertiesToCsv(properties));
});
