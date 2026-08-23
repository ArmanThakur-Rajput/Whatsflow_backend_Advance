// Restricts a route to the superadmin role only. Distinct from adminOnly —
// a tenant admin must NEVER pass this check, since superadmin routes can
// see and manage data across every tenant (that's the whole point of the
// panel: monitoring/managing admins org-wide).
module.exports = (req, res, next) => {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({
      message: 'Super admin access required',
    });
  }
  next();
};
