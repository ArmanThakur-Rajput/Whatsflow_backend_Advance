const { body, param } = require('express-validator');

const objectId = (name) =>
  param(name).isMongoId().withMessage('Invalid id');

module.exports = {
  // POST /admin/employees
  // Password stays optional — addEmployee falls back to a default
  // ('employee123'), which is an intended, UI-advertised feature, not a bug.
  // We only enforce a minimum length on it when one IS supplied, matching
  // the same 6-char rule already used in changePassword.
  addEmployeeRules: [
    body('name').isString().trim().notEmpty().withMessage('Name is required')
      .isLength({ max: 120 }).withMessage('Name too long'),
    body('email').isString().trim().notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Invalid email').normalizeEmail(),
    body('phone').optional({ checkFalsy: true }).isString().trim()
      .isLength({ max: 20 }).withMessage('Phone is too long'),
    body('password').optional({ checkFalsy: true }).isString()
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],

  // PATCH /admin/employees/:id
  updateEmployeeRules: [
    objectId('id'),
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 })
      .withMessage('Name cannot be empty'),
    body('email').optional().isString().trim().notEmpty().withMessage('Email cannot be empty')
      .isEmail().withMessage('Invalid email').normalizeEmail(),
    body('phone').optional({ checkFalsy: true }).isString().trim()
      .isLength({ max: 20 }).withMessage('Phone is too long'),
  ],
  // PATCH /auth/profile (self-service, no email field — only name/phone)
  updateProfileRules: [
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 })
      .withMessage('Name cannot be empty'),
    body('phone').optional({ checkFalsy: true }).isString().trim()
      .isLength({ max: 20 }).withMessage('Phone is too long'),
  ],
};
