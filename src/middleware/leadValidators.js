const { body, query, param } = require('express-validator');

const LEAD_STATUSES = ['New', 'Interested', 'Contacted', 'Not Interested', 'Pending', 'Booked'];

// Strips country code prefix (+91, 91) then removes all non-digits.
// Returns only the 10-digit number or throws for validation.
const normalizePhone = (value) => {
  if (!value) return value;
  let cleaned = String(value).trim();
  // Remove +91 or leading 91 (country code)
  cleaned = cleaned.replace(/^\+91/, '').replace(/^91(?=\d{10}$)/, '');
  // Remove spaces, dashes, brackets, dots
  cleaned = cleaned.replace(/[\s\-().+]/g, '');
  return cleaned;
};

const objectId = (name) =>
  param(name).isMongoId().withMessage('Invalid id');

module.exports = {
  LEAD_STATUSES,
  normalizePhone,

  loginRules: [
    body('email').isString().trim().notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Invalid email').normalizeEmail(),
    body('password').isString().notEmpty().withMessage('Password is required'),
  ],

  listLeadsRules: [
    query('search').optional().isString().trim().isLength({ max: 100 }),
    query('status').optional().isString().trim(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],

  idRule: [objectId('id')],

  updateStatusRules: [
    objectId('id'),
    body('status').isString().trim().isIn(LEAD_STATUSES)
      .withMessage(`Invalid status. Allowed: ${LEAD_STATUSES.join(', ')}`),
  ],

  addNoteRules: [
    objectId('id'),
    body('note').isString().trim().notEmpty().withMessage('Note is required')
      .isLength({ max: 1000 }).withMessage('Note too long'),
  ],

  followUpRules: [
    objectId('id'),
    body('date').isString().trim().notEmpty().withMessage('Date is required'),
    body('time').isString().trim().notEmpty().withMessage('Time is required'),
    body('notes').optional().isString().trim().isLength({ max: 1000 }),
  ],

  updateInfoRules: [
    objectId('id'),
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
    body('phone').optional().isString().trim()
      .customSanitizer(normalizePhone)
      .matches(/^\d{10}$/).withMessage('Phone must be exactly 10 digits (no country code)'),
    body('campaign').optional().isString().trim().isLength({ max: 120 }),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Invalid email'),
    body('city').optional().isString().trim().isLength({ max: 80 }),
    body('car').optional().isString().trim().isLength({ max: 80 }),
  ],

  createLeadRules: [
    body('name')
      .isString().trim().notEmpty().withMessage('Name is required')
      .isLength({ max: 120 }).withMessage('Name too long'),

    body('primaryPhone')
      .isString().trim().notEmpty().withMessage('Primary phone is required')
      .customSanitizer(normalizePhone)
      .matches(/^\d{10}$/).withMessage('Primary phone must be exactly 10 digits (no country code)'),

    body('secondaryPhone')
      .optional({ checkFalsy: true })
      .isString().trim()
      .customSanitizer(normalizePhone)
      .matches(/^\d{10}$/).withMessage('Secondary phone must be exactly 10 digits (no country code)')
      .custom((value, { req }) => {
        if (value && value === req.body.primaryPhone) {
          throw new Error('Secondary phone cannot be the same as primary phone');
        }
        return true;
      }),

    body('email')
      .optional({ checkFalsy: true })
      .isEmail().withMessage('Invalid email'),

    body('city').optional().isString().trim().isLength({ max: 80 }),
    body('source').optional().isString().trim().isLength({ max: 40 }),
    body('campaign').optional().isString().trim().isLength({ max: 120 }),
    body('car').optional().isString().trim().isLength({ max: 80 }),
    body('assignedTo')
      .optional({ checkFalsy: true })
      .isMongoId().withMessage('Invalid assignedTo employee ID'),
    body('status')
      .optional({ checkFalsy: true })
      .isString().trim().isIn(LEAD_STATUSES)
      .withMessage(`Invalid status. Allowed: ${LEAD_STATUSES.join(', ')}`),
  ],
};
