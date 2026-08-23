const { body, param } = require('express-validator');

const objectId = (name) =>
  param(name).isMongoId().withMessage('Invalid id');

module.exports = {
  // POST /super-admin/admins — creates a new Account + its first admin
  // in one shot, since an admin can't exist without a tenant to belong to.
  addAdminRules: [
    body('orgName').isString().trim().notEmpty().withMessage('Organization name is required')
      .isLength({ max: 120 }).withMessage('Organization name too long'),
    body('businessType').optional({ checkFalsy: true }).isString().trim()
      .isLength({ max: 80 }).withMessage('Business type too long'),
    body('name').isString().trim().notEmpty().withMessage('Admin name is required')
      .isLength({ max: 120 }).withMessage('Name too long'),
    body('email').isString().trim().notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Invalid email').normalizeEmail(),
    body('phone').optional({ checkFalsy: true }).isString().trim()
      .isLength({ max: 20 }).withMessage('Phone is too long'),
    body('password').optional({ checkFalsy: true }).isString()
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],

  // PATCH /super-admin/admins/:id
  updateAdminRules: [
    objectId('id'),
    body('name').optional().isString().trim().isLength({ min: 1, max: 120 })
      .withMessage('Name cannot be empty'),
    body('email').optional().isString().trim().notEmpty().withMessage('Email cannot be empty')
      .isEmail().withMessage('Invalid email').normalizeEmail(),
    body('phone').optional({ checkFalsy: true }).isString().trim()
      .isLength({ max: 20 }).withMessage('Phone is too long'),
  ],

  idParamRule: [objectId('id')],
};
