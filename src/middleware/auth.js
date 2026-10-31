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
  } catch (err) {
    // Sirf asli token problem pe 401 do (app tabhi logout karta hai).
    // DB timeout / network glitch pe 401 nahi dena, warna user random logout ho jaata hai.
    if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError')) {
      return res.status(401).json({ message: 'Invalid token' });
    }
    console.error('[auth middleware] non-token error:', err && err.message);
    return res.status(503).json({ message: 'Server busy, please retry' });
  }
};