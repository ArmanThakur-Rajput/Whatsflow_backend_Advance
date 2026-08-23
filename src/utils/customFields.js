const CustomFieldDefinition = require('../models/CustomFieldDefinition.model');

/**
 * Validates a submitted customFields object against the tenant's
 * currently-active field definitions, and returns a clean Map ready to
 * assign to Lead.customFields.
 *
 * Design choices:
 *  - Unknown keys (not defined by this tenant, or belonging to a
 *    different tenant entirely) are silently dropped rather than
 *    rejected — this keeps the endpoint forgiving of stale clients that
 *    still hold a field the admin since deleted/deactivated, instead of
 *    hard-failing the whole lead save over it.
 *  - Inactive fields are NOT accepted for new values (an admin who
 *    deactivated a field doesn't want new leads filling it in), but
 *    existing saved values for an inactive field are left untouched by
 *    the caller (this function only processes what's actually submitted).
 *  - `required` fields must be present and non-empty, but ONLY for
 *    create — see `requireAll` param. On update (partial edits), a
 *    required field is only enforced if the caller actually touched it
 *    (passed it in `customFields`), so editing one field doesn't force
 *    re-submitting every other required field too.
 *
 * @param {string} tenantId
 * @param {object} submitted - raw req.body.customFields (plain object, key -> value)
 * @param {boolean} requireAll - true for create (every required field must be present)
 * @returns {Promise<{ values: Map<string, any>, error: string|null }>}
 */
async function validateCustomFields(tenantId, submitted, requireAll) {
  const definitions = await CustomFieldDefinition.find({ tenantId, isActive: true });
  const values = new Map();

  if (submitted && typeof submitted === 'object') {
    for (const def of definitions) {
      if (!(def.key in submitted)) continue; // not touched by this request

      const raw = submitted[def.key];

      if (raw === null || raw === undefined || raw === '') {
        if (def.required) {
          return { values: null, error: `${def.label} is required` };
        }
        continue; // optional + empty -> just don't store it
      }

      switch (def.type) {
        case 'number': {
          const num = Number(raw);
          if (Number.isNaN(num)) {
            return { values: null, error: `${def.label} must be a number` };
          }
          values.set(def.key, num);
          break;
        }
        case 'select': {
          if (!def.options.includes(String(raw))) {
            return { values: null, error: `${def.label} must be one of: ${def.options.join(', ')}` };
          }
          values.set(def.key, String(raw));
          break;
        }
        case 'date': {
          const d = new Date(raw);
          if (Number.isNaN(d.getTime())) {
            return { values: null, error: `${def.label} must be a valid date` };
          }
          values.set(def.key, d.toISOString());
          break;
        }
        default: { // 'text'
          values.set(def.key, String(raw).trim().slice(0, 500));
        }
      }
    }
  }

  if (requireAll) {
    for (const def of definitions) {
      if (def.required && !values.has(def.key)) {
        return { values: null, error: `${def.label} is required` };
      }
    }
  }

  return { values, error: null };
}

module.exports = { validateCustomFields };
