const { validationResult } = require('express-validator');

// Runs after express-validator rules; returns 400 if any failed.
module.exports = function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: errors.array()[0].msg,
      errors: errors.array().map((e) => ({ field: e.path, msg: e.msg })),
    });
  }
  next();
};