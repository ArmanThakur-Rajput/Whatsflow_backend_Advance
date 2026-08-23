const CustomFieldDefinition = require('../models/CustomFieldDefinition.model');
const asyncHandler = require('../utils/asyncHandler');

const VALID_TYPES = ['text', 'number', 'select', 'date'];

// Turns "Package Type" into "package_type" — the stable key saved
// fields are keyed by. Strips anything that isn't alphanumeric/space,
// then joins with underscores.
function slugify(label) {
  return String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
}

// GET /custom-fields — list this tenant's field definitions.
// ?includeInactive=true also returns soft-deleted (deactivated) fields,
// used by the admin's field-builder screen so they can see/reactivate
// fields they removed earlier; the lead create/edit form on the other
// hand should NOT pass this, since it only wants active fields.
exports.getCustomFields = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const filter = { tenantId };
  if (req.query.includeInactive !== 'true') filter.isActive = true;

  const fields = await CustomFieldDefinition.find(filter).sort({ order: 1, createdAt: 1 });
  res.json({ fields });
});

// POST /custom-fields — admin only, create a new field definition.
exports.createCustomField = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const { label, type, options, required } = req.body;

  if (!label || !label.trim()) {
    return res.status(400).json({ message: 'Label is required' });
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ message: `Type must be one of: ${VALID_TYPES.join(', ')}` });
  }

  let cleanOptions = [];
  if (type === 'select') {
    if (!Array.isArray(options) || options.filter((o) => String(o).trim()).length < 1) {
      return res.status(400).json({ message: 'Select fields need at least 1 option' });
    }
    // de-dupe while preserving order
    const seen = new Set();
    cleanOptions = options
      .map((o) => String(o).trim())
      .filter((o) => o && !seen.has(o) && seen.add(o));
  }

  const key = slugify(label);
  if (!key) {
    return res.status(400).json({ message: 'Label must contain at least one letter or number' });
  }

  const existing = await CustomFieldDefinition.findOne({ tenantId, key });
  if (existing) {
    return res.status(409).json({
      message: 'A field with this name already exists',
      existingFieldId: existing._id,
    });
  }

  const count = await CustomFieldDefinition.countDocuments({ tenantId });

  const field = await CustomFieldDefinition.create({
    tenantId,
    label: label.trim(),
    key,
    type,
    options: cleanOptions,
    required: !!required,
    order: count,
  });

  res.status(201).json({ message: 'Custom field created', field });
});

// PATCH /custom-fields/:id — admin only. Label, required, and (for
// select fields) options can be changed freely; `type` and `key` are
// intentionally NOT editable here — changing a field's type after
// leads already have values saved against it would make that historical
// data inconsistent (e.g. a text value sitting in what's now a number
// field). Delete and recreate instead if the type itself is wrong.
exports.updateCustomField = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const { label, options, required, order } = req.body;

  const field = await CustomFieldDefinition.findOne({ _id: req.params.id, tenantId });
  if (!field) return res.status(404).json({ message: 'Custom field not found' });

  if (label !== undefined) {
    if (!label.trim()) return res.status(400).json({ message: 'Label cannot be empty' });
    field.label = label.trim();
  }
  if (required !== undefined) field.required = !!required;
  if (order !== undefined) field.order = Number(order) || 0;

  if (options !== undefined) {
    if (field.type !== 'select') {
      return res.status(400).json({ message: 'Only select fields have options' });
    }
    const seen = new Set();
    const cleanOptions = (Array.isArray(options) ? options : [])
      .map((o) => String(o).trim())
      .filter((o) => o && !seen.has(o) && seen.add(o));
    if (cleanOptions.length < 1) {
      return res.status(400).json({ message: 'Select fields need at least 1 option' });
    }
    field.options = cleanOptions;
  }

  await field.save();
  res.json({ message: 'Custom field updated', field });
});

// DELETE /custom-fields/:id — admin only. HARD delete — permanently removes
// the field definition. Existing lead data that had a value for this field
// will no longer show it anywhere (lead detail, template, import) since
// the definition is gone. This is intentional: admin deleted the field,
// so it should disappear completely — no "reactivate" prompt shown.
exports.deleteCustomField = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const field = await CustomFieldDefinition.findOneAndDelete({ _id: req.params.id, tenantId });
  if (!field) return res.status(404).json({ message: 'Custom field not found' });
  res.json({ message: 'Custom field deleted', field });
});

// PATCH /custom-fields/:id/reactivate — kept for API compatibility but
// returns 410 Gone since fields are now hard-deleted, not soft-deleted.
exports.reactivateCustomField = asyncHandler(async (req, res) => {
  res.status(410).json({ message: 'Fields are permanently deleted and cannot be reactivated. Create a new field instead.' });
});
