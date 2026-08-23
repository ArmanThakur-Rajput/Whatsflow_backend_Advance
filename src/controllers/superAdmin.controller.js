const User = require('../models/User.model');
const Account = require('../models/Account.model');
const Lead = require('../models/Lead.model');
const asyncHandler = require('../utils/asyncHandler');

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT — scope of this controller:
// Super admin can see and manage ORGANIZATIONS (Accounts) and the ADMIN
// USERS that belong to them. It deliberately never reads/writes Leads,
// Appointments, CustomFieldDefinitions, schedules, or any other
// tenant-owned business data — that data stays invisible to super admin,
// exactly as requested ("he cant see the data under that organization").
// The one place we touch Lead is a single countDocuments() for a
// dashboard number (how many leads an org has) — read-only, aggregate
// count only, never the lead documents themselves.
// ─────────────────────────────────────────────────────────────────────────────

// GET /super-admin/organizations
// List every organization (Account) with its admin count + lead count,
// for the monitoring dashboard.
exports.getOrganizations = asyncHandler(async (req, res) => {
  const accounts = await Account.find().sort({ createdAt: -1 }).lean();
  const accountIds = accounts.map((a) => a._id);

  const [adminCounts, leadCounts] = await Promise.all([
    User.aggregate([
      { $match: { tenantId: { $in: accountIds }, role: 'admin' } },
      { $group: { _id: '$tenantId', count: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } },
    ]),
    // Aggregate count only — no lead documents/data ever returned.
    Lead.aggregate([
      { $match: { tenantId: { $in: accountIds } } },
      { $group: { _id: '$tenantId', count: { $sum: 1 } } },
    ]),
  ]);

  const adminById = Object.fromEntries(adminCounts.map((c) => [String(c._id), c]));
  const leadById = Object.fromEntries(leadCounts.map((c) => [String(c._id), c.count]));

  const organizations = accounts.map((acc) => ({
    ...acc,
    adminCount: adminById[String(acc._id)]?.count || 0,
    activeAdminCount: adminById[String(acc._id)]?.active || 0,
    totalLeads: leadById[String(acc._id)] || 0,
  }));

  res.json({ organizations });
});

// GET /super-admin/admins
// List every admin across every organization (for the flat "all admins"
// view), each tagged with their organization's name.
exports.getAllAdmins = asyncHandler(async (req, res) => {
  const admins = await User.find({ role: 'admin' })
    .select('-password')
    .populate('tenantId', 'name businessType isActive')
    .sort({ createdAt: -1 })
    .lean();

  res.json({ admins });
});

// GET /super-admin/organizations/:id/admins
// Admins belonging to one specific organization.
exports.getAdminsByOrg = asyncHandler(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) return res.status(404).json({ message: 'Organization not found' });

  const admins = await User.find({ tenantId: account._id, role: 'admin' })
    .select('-password')
    .sort({ createdAt: -1 });

  res.json({ organization: account, admins });
});

// POST /super-admin/admins
// Creates a brand-new organization (Account) AND its first admin in one
// step — an admin can never exist without a tenant, so the panel offers
// "add new admin" as effectively "onboard a new organization".
exports.addAdmin = asyncHandler(async (req, res) => {
  const { orgName, businessType, name, email, phone, password } = req.body;

  const exists = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (exists) {
    return res.status(400).json({ message: 'Email already exists' });
  }

  const account = await Account.create({
    name: orgName,
    businessType: businessType || '',
    isActive: true,
  });

  const admin = await User.create({
    tenantId: account._id,
    name,
    email,
    phone,
    password: password || 'admin123',
    role: 'admin',
    isActive: true,
  });

  res.json({
    message: 'Admin and organization created successfully',
    organization: account,
    admin: { _id: admin._id, name: admin.name, email: admin.email, tenantId: admin.tenantId },
  });
});

// POST /super-admin/organizations/:id/admins
// Adds another admin to an EXISTING organization (an org can have
// multiple admins).
exports.addAdminToOrg = asyncHandler(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) return res.status(404).json({ message: 'Organization not found' });

  const { name, email, phone, password } = req.body;
  const exists = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (exists) {
    return res.status(400).json({ message: 'Email already exists' });
  }

  const admin = await User.create({
    tenantId: account._id,
    name, email, phone,
    password: password || 'admin123',
    role: 'admin',
    isActive: true,
  });

  res.json({
    message: 'Admin added successfully',
    admin: { _id: admin._id, name: admin.name, email: admin.email },
  });
});

// PATCH /super-admin/admins/:id
// Edit an admin's profile fields. Cannot be used to move an admin to a
// different organization (tenantId is never accepted from the body) —
// keeps the tenant boundary fixed once an admin is created.
exports.updateAdmin = asyncHandler(async (req, res) => {
  const { name, email, phone } = req.body;

  const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
  if (!admin) return res.status(404).json({ message: 'Admin not found' });

  if (email && email.toLowerCase().trim() !== admin.email) {
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(400).json({ message: 'Email already exists' });
  }

  if (name !== undefined) admin.name = name;
  if (email !== undefined) admin.email = email;
  if (phone !== undefined) admin.phone = phone;
  await admin.save();

  res.json({ message: 'Admin updated successfully' });
});

// PATCH /super-admin/admins/:id/toggle
// Activate/deactivate an admin (locks them out without deleting their
// account or any of their organization's data).
exports.toggleAdminStatus = asyncHandler(async (req, res) => {
  const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
  if (!admin) return res.status(404).json({ message: 'Admin not found' });

  admin.isActive = !admin.isActive;
  await admin.save();

  res.json({
    message: `Admin ${admin.isActive ? 'activated' : 'deactivated'}`,
    isActive: admin.isActive,
  });
});

// DELETE /super-admin/admins/:id
// Deletes the admin USER ACCOUNT ONLY. Deliberately does NOT touch the
// organization (Account) or any of its leads/employees/data — deleting
// the login does not wipe the business's data. If it was the org's last
// admin, the org is left adminless but its data is fully intact (a new
// admin can be added back to the same organization later).
exports.deleteAdmin = asyncHandler(async (req, res) => {
  const admin = await User.findOne({ _id: req.params.id, role: 'admin' });
  if (!admin) return res.status(404).json({ message: 'Admin not found' });

  await User.deleteOne({ _id: admin._id });

  res.json({ message: 'Admin removed successfully' });
});

// PATCH /super-admin/organizations/:id/toggle
// Activate/deactivate an entire organization. When inactive, ALL of that
// org's admins and employees should be treated as locked out — enforced
// in the auth middleware (see auth.js) by checking the linked Account's
// isActive flag, not just the user's own.
exports.toggleOrgStatus = asyncHandler(async (req, res) => {
  const account = await Account.findById(req.params.id);
  if (!account) return res.status(404).json({ message: 'Organization not found' });

  account.isActive = !account.isActive;
  await account.save();

  res.json({
    message: `Organization ${account.isActive ? 'activated' : 'deactivated'}`,
    isActive: account.isActive,
  });
});
