const Lead = require('../models/Lead.model');
const User = require('../models/User.model');
const Notification = require('../models/Notification.model');
const CustomFieldDefinition = require('../models/CustomFieldDefinition.model');
const { getNextEmployee } = require('../utils/autoAssign');
const { validateCustomFields } = require('../utils/customFields');
const { normalizePhone } = require('../middleware/leadValidators');
const sendPushNotification = require('../utils/sendPushNotification');
const asyncHandler = require('../utils/asyncHandler');
const { parse } = require('csv-parse/sync');

// ─── Fixed columns that every tenant's template always has ───────────────────
const FIXED_COLUMNS = ['name', 'phone', 'email', 'city'];

// ─── GET /leads/import/template ──────────────────────────────────────────────
// Returns a downloadable CSV file whose header row = fixed columns +
// this tenant's currently-active custom fields (in display order).
// Tenant A's template will differ from Tenant B's — fully isolated.
exports.downloadTemplate = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;

  const customFields = await CustomFieldDefinition.find({ tenantId, isActive: true })
    .sort({ order: 1 });

  const customColumns = customFields.map((f) => f.key);
  const allColumns = [...FIXED_COLUMNS, ...customColumns];

  // Build a two-row CSV: header + one example row so admin understands format
  const exampleRow = allColumns.map((col) => {
    const def = customFields.find((f) => f.key === col);
    if (!def) {
      // fixed column examples
      const examples = {
        name: 'Rahul Sharma', phone: '9876543210',
        email: 'rahul@example.com', city: 'Mumbai',
      };
      return examples[col] || '';
    }
    // custom field examples by type
    switch (def.type) {
      case 'number': return '10000';
      case 'date': return '2025-08-15';
      case 'select': return def.options[0] || 'Option1';
      default: return 'Sample Text';
    }
  });

  const csvContent = [
    allColumns.join(','),
    exampleRow.join(','),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads_template.csv"');
  res.send(csvContent);
});

// ─── POST /leads/import ──────────────────────────────────────────────────────
// Accepts a multipart CSV upload. Parses, validates, deduplicates, and
// bulk-creates leads — round-robin assigning to this tenant's employees.
// Returns a summary: { total, imported, skipped, errors[] }
exports.importLeads = asyncHandler(async (req, res) => {
  const { tenantId, name: adminName } = req.user;

  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  // ── Parse CSV ──────────────────────────────────────────────────────────────
  let rows;
  try {
    rows = parse(req.file.buffer, {
      columns: true,         // use first row as keys
      skip_empty_lines: true,
      trim: true,
    });
  } catch (parseErr) {
    return res.status(400).json({ message: 'Invalid CSV file — could not parse' });
  }

  if (!rows.length) {
    return res.status(400).json({ message: 'CSV is empty — no data rows found' });
  }

  // ── Validate template match — STRICT ─────────────────────────────────────
  // The uploaded CSV must match the downloaded template EXACTLY:
  //   1. Every fixed column must be present
  //   2. Every active custom field column must be present
  //   3. No extra unknown columns allowed
  //   4. Column count must match exactly
  // This prevents silent empty-field imports when someone uploads a
  // generic CSV that happens to have name/phone but none of the custom
  // field columns (e.g. uploading "Bank" instead of "bank").

  // Fetch tenant's active custom field definitions BEFORE column check
  const customFieldDefs = await CustomFieldDefinition.find({ tenantId, isActive: true })
    .sort({ order: 1 });
  const customFieldKeys = customFieldDefs.map((d) => d.key);

  // Expected columns = exactly what downloadTemplate generates
  const expectedColumns = [...FIXED_COLUMNS, ...customFieldKeys];
  const uploadedColumns = Object.keys(rows[0]);

  // Check 1: missing required columns
  const missingColumns = expectedColumns.filter((c) => !uploadedColumns.includes(c));
  if (missingColumns.length) {
    return res.status(400).json({
      message: `CSV format mismatch — missing columns: ${missingColumns.join(', ')}. Please download the template again and use it.`,
    });
  }

  // Check 2: extra unknown columns not in template
  const extraColumns = uploadedColumns.filter((c) => !expectedColumns.includes(c));
  if (extraColumns.length) {
    return res.status(400).json({
      message: `CSV format mismatch — unexpected columns found: ${extraColumns.join(', ')}. Please use the downloaded template exactly.`,
    });
  }

  // Check 3: column count must be exact
  if (uploadedColumns.length !== expectedColumns.length) {
    return res.status(400).json({
      message: `CSV format mismatch — expected ${expectedColumns.length} columns, got ${uploadedColumns.length}. Please download the template again.`,
    });
  }

  // ── Fetch active employees for round-robin (once, not per row) ────────────
  const employees = await User.find(
    { tenantId, role: 'employee', isActive: true },
    '_id pushTokens'
  ).sort({ createdAt: 1 });

  // ── Process rows ──────────────────────────────────────────────────────────
  const errors = [];
  const createdLeads = [];
  const assignedEmployeeSet = new Set(); // track who got at least one lead

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-indexed, +1 for header row

    // --- Required field: name ---
    if (!row.name || !row.name.trim()) {
      errors.push({ row: rowNum, reason: 'Name is missing' });
      continue;
    }

    // --- Required field: phone ---
    if (!row.phone || !row.phone.trim()) {
      errors.push({ row: rowNum, name: row.name, reason: 'Phone is missing' });
      continue;
    }

    let phone;
    try {
      phone = normalizePhone(row.phone.trim());
    } catch {
      errors.push({ row: rowNum, name: row.name, reason: 'Invalid phone number format' });
      continue;
    }

    if (!/^\d{10}$/.test(phone)) {
      errors.push({ row: rowNum, name: row.name, reason: 'Phone must be exactly 10 digits' });
      continue;
    }

    // --- Duplicate phone check (scoped to this tenant) ---
    const existing = await Lead.findOne({
      tenantId,
      $or: [{ phone }, { secondaryPhone: phone }],
    }).select('_id name');

    if (existing) {
      errors.push({
        row: rowNum,
        name: row.name,
        reason: `Duplicate phone — already exists as "${existing.name}"`,
      });
      continue;
    }

    // --- Custom fields: extract and validate ---
    const submittedCustom = {};
    for (const key of customFieldKeys) {
      if (key in row) submittedCustom[key] = row[key];
    }

    const { values: customFieldValues, error: cfError } =
      await validateCustomFields(tenantId, submittedCustom, false); // requireAll=false for import

    if (cfError) {
      errors.push({ row: rowNum, name: row.name, reason: cfError });
      continue;
    }

    // --- Round-robin assign ---
    const assigneeId = await getNextEmployee(tenantId);

    // --- Create lead ---
    try {
      const lead = await Lead.create({
        tenantId,
        name: String(row.name).trim().slice(0, 120),
        phone,
        email: String(row.email || '').trim().slice(0, 120),
        city: String(row.city || '').trim().slice(0, 80),
        source: 'CSV Import',
        campaign: '',
        customFields: customFieldValues,
        status: 'New',
        assignedTo: assigneeId,
        timeline: [{
          type: 'created',
          description: `Lead imported from CSV by ${adminName}`,
        }],
      });

      createdLeads.push({ leadId: lead._id, assigneeId });
      if (assigneeId) assignedEmployeeSet.add(assigneeId.toString());
    } catch (createErr) {
      errors.push({ row: rowNum, name: row.name, reason: 'Failed to create — ' + createErr.message });
    }
  }

  // ── Send notifications to employees who got at least one lead ─────────────
  if (assignedEmployeeSet.size > 0 && createdLeads.length > 0) {
    const affectedEmployees = employees.filter((e) =>
      assignedEmployeeSet.has(e._id.toString())
    );

    // Count per employee
    const countPerEmployee = {};
    for (const { assigneeId } of createdLeads) {
      if (!assigneeId) continue;
      const key = assigneeId.toString();
      countPerEmployee[key] = (countPerEmployee[key] || 0) + 1;
    }

    await Promise.allSettled(
      affectedEmployees.map(async (emp) => {
        const count = countPerEmployee[emp._id.toString()] || 0;
        const title = '🎯 New Leads Assigned!';
        const message = `${count} new lead${count > 1 ? 's have' : ' has'} been imported and assigned to you. Check your list!`;

        // In-app notification
        await Notification.create({
          tenantId,
          user: emp._id,
          title,
          message,
          type: 'info',
          createdBy: req.user._id,
        });

        // Push notification
        if (emp.pushTokens?.length) {
          await Promise.allSettled(emp.pushTokens.map(t => sendPushNotification(t, title, message)));
        }
      })
    );
  }

  // ── Summary response ───────────────────────────────────────────────────────
  res.status(200).json({
    message: 'Import complete',
    summary: {
      total: rows.length,
      imported: createdLeads.length,
      skipped: errors.length,
      errors,
    },
  });
});
