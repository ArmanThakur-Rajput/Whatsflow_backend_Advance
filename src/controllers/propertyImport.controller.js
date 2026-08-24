const Property = require('../models/Property.model');
const PropertyMasterData = require('../models/PropertyMasterData.model');
const asyncHandler = require('../utils/asyncHandler');
const { parse } = require('csv-parse/sync');

// Fixed CSV columns for property import
const PROPERTY_COLUMNS = [
  'projectName', 'intent', 'propertyType', 'carpetArea',
  'buildupArea', 'location', 'address', 'price',
  'amenities', 'parking', 'notes', 'ownerName', 'ownerPhone',
];

// GET /property-crm/import/template
exports.downloadPropertyTemplate = asyncHandler(async (req, res) => {
  const exampleRow = [
    'Sunrise Heights', 'buy', 'Flat', '850',
    '1100', 'Baner', '123 Main Street Baner Pune', '4500000',
    'Swimming Pool;Gym;Security', 'Covered', 'Corner flat on 3rd floor',
    'Rajesh Kumar', '9876543210',
  ];

  const csvContent = [
    PROPERTY_COLUMNS.join(','),
    exampleRow.join(','),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="properties_template.csv"');
  res.send(csvContent);
});

// POST /property-crm/import
exports.importProperties = asyncHandler(async (req, res) => {
  const { tenantId, name: adminName, _id: adminId } = req.user;

  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  let rows;
  try {
    rows = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch {
    return res.status(400).json({ message: 'Invalid CSV file — could not parse' });
  }

  if (!rows.length) {
    return res.status(400).json({ message: 'CSV is empty — no data rows found' });
  }

  // Column check — must have at minimum projectName, intent, propertyType, location
  const uploadedColumns = Object.keys(rows[0]);
  const missingRequired = ['projectName', 'intent', 'propertyType', 'location'].filter(
    (c) => !uploadedColumns.includes(c)
  );
  if (missingRequired.length) {
    return res.status(400).json({
      message: `Missing required columns: ${missingRequired.join(', ')}. Please download the template.`,
    });
  }

  const errors = [];
  const created = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    // Skip fully empty rows
    const allEmpty = Object.values(row).every((v) => !String(v).trim());
    if (allEmpty) continue;

    // Required: projectName
    if (!row.projectName?.trim()) {
      errors.push({ row: rowNum, reason: 'projectName is missing' });
      continue;
    }

    // Required: intent
    const intent = String(row.intent || '').trim().toLowerCase();
    if (!['rent', 'buy'].includes(intent)) {
      errors.push({ row: rowNum, name: row.projectName, reason: 'intent must be "rent" or "buy"' });
      continue;
    }

    // Required: propertyType
    if (!row.propertyType?.trim()) {
      errors.push({ row: rowNum, name: row.projectName, reason: 'propertyType is missing' });
      continue;
    }

    // Required: location
    if (!row.location?.trim()) {
      errors.push({ row: rowNum, name: row.projectName, reason: 'location is missing' });
      continue;
    }

    // Duplicate check: same projectName + location + propertyType in this tenant
    const existing = await Property.findOne({
      tenantId,
      projectName: { $regex: `^${row.projectName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      location: row.location.trim(),
      propertyType: row.propertyType.trim(),
    }).select('_id');

    if (existing) {
      errors.push({
        row: rowNum,
        name: row.projectName,
        reason: 'Duplicate — property with same name, location and type already exists',
      });
      continue;
    }

    // Parse amenities (semicolon-separated in CSV)
    const amenities = row.amenities
      ? String(row.amenities).split(';').map((a) => a.trim()).filter(Boolean)
      : [];

    try {
      const prop = await Property.create({
        tenantId,
        projectName: String(row.projectName).trim(),
        intent,
        propertyType: String(row.propertyType).trim(),
        carpetArea: String(row.carpetArea || '').trim(),
        buildupArea: String(row.buildupArea || '').trim(),
        location: String(row.location).trim(),
        address: String(row.address || '').trim(),
        price: String(row.price || '').trim(),
        amenities,
        parking: String(row.parking || '').trim(),
        notes: String(row.notes || '').trim(),
        ownerName: String(row.ownerName || '').trim(),
        ownerPhone: String(row.ownerPhone || '').trim(),
        createdBy: adminId,
        status: 'available',
      });
      created.push(prop._id);
    } catch (createErr) {
      errors.push({ row: rowNum, name: row.projectName, reason: 'Failed to create: ' + createErr.message });
    }
  }

  res.status(200).json({
    message: 'Import complete',
    summary: {
      total: rows.length,
      imported: created.length,
      skipped: errors.length,
      errors,
    },
  });
});

// GET /property-crm/export  — export all properties as CSV
exports.exportProperties = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const { dateFrom, dateTo, status } = req.query;

  const filter = { tenantId };
  if (status) filter.status = status;
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
    if (dateTo)   filter.createdAt.$lte = new Date(`${dateTo}T23:59:59.999Z`);
  }

  const properties = await Property.find(filter).sort({ createdAt: -1 }).lean();

  const escape = (val) => {
    const str = val == null ? '' : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = [
    'Project Name', 'Intent', 'Property Type', 'Status',
    'Carpet Area', 'Buildup Area', 'Location', 'Address',
    'Price', 'Amenities', 'Parking', 'Notes',
    'Owner Name', 'Owner Phone', 'Created At',
  ];

  const rows = [headers.join(',')];
  properties.forEach((p) => {
    rows.push([
      escape(p.projectName),
      escape(p.intent),
      escape(p.propertyType),
      escape(p.status),
      escape(p.carpetArea),
      escape(p.buildupArea),
      escape(p.location),
      escape(p.address),
      escape(p.price),
      escape((p.amenities || []).join('; ')),
      escape(p.parking),
      escape(p.notes),
      escape(p.ownerName),
      escape(p.ownerPhone),
      escape(p.createdAt ? new Date(p.createdAt).toLocaleDateString('en-IN') : ''),
    ].join(','));
  });

  const csv = rows.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="properties_${dateFrom ?? 'all'}_to_${dateTo ?? 'all'}.csv"`);
  res.send(csv);
});
