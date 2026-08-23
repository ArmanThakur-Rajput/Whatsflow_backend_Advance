const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Account = require('../models/Account.model');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Token missing' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'User not found' });
    }

    // For admin/employee (anyone with a tenant), also check their
    // organization hasn't been deactivated by super admin — a disabled
    // org locks out everyone under it, not just the user being individually
    // toggled. superadmin has no tenantId, so this is skipped for them.
    if (user.tenantId) {
      const account = await Account.findById(user.tenantId).select('isActive').lean();
      if (!account || !account.isActive) {
        return res.status(403).json({ message: 'Organization is inactive' });
      }
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }
};