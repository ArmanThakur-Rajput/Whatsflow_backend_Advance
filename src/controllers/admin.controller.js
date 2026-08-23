const User = require('../models/User.model');
const Lead = require('../models/Lead.model');
const Appointment = require('../models/Appointment.model');
const CustomFieldDefinition = require('../models/CustomFieldDefinition.model');
const bcrypt = require('bcryptjs');
const asyncHandler = require('../utils/asyncHandler');
const { startOfDay, endOfDay, startOfDaysAgo, todayString, startOfMonth, APP_TZ } = require('../utils/dateRange');

// Escape user input before using it in a Mongo $regex to prevent ReDoS / injection.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Admin Stats (overview numbers)
exports.getAdminStats = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const today = startOfDay();
  const todayEnd = endOfDay();
  const monthStart = startOfMonth();
  const todayKey = todayString();

  const todayFilter = { tenantId, createdAt: { $gte: today, $lte: todayEnd } };
  const monthFilter = { tenantId, createdAt: { $gte: monthStart } };

  const [
    monthLeads, todayLeads, interested,
    contacted, notInterested, bookedToday, activeEmployees,
    monthBooked, appointmentsToday, pendingLeads, allBooked,
  ] = await Promise.all([
    Lead.countDocuments(monthFilter),
    Lead.countDocuments(todayFilter),
    Lead.countDocuments({ ...todayFilter, status: 'Interested' }),
    Lead.countDocuments({ ...todayFilter, status: 'Contacted' }),
    Lead.countDocuments({ ...todayFilter, status: 'Not Interested' }),
    Lead.countDocuments({ ...todayFilter, status: 'Booked' }),
    User.countDocuments({ tenantId, role: 'employee', isActive: true }),
    Lead.countDocuments({ ...monthFilter, status: 'Booked' }),
    Appointment.countDocuments({ tenantId, appointmentDate: todayKey }),
    Lead.countDocuments({ tenantId, status: 'Pending' }),
    Lead.countDocuments({ tenantId, status: 'Booked' }),
  ]);

  const conversionRate = monthLeads > 0
    ? Math.round((monthBooked / monthLeads) * 100)
    : 0;

  res.json({
    monthLeads,
    todayLeads,
    interested, contacted, notInterested,
    booked: bookedToday,
    allBooked,
    activeEmployees,
    conversionRate,
    appointmentsToday,
    pendingLeads,
  });
});

// Monthly Leads Trend — rolling last 6 months (real data, timezone-aware).
// Returns: { trend: [{ label: 'Jul', year: 2026, count: 12 }, ...] }
// Always ends on the current month, so it auto-rolls forward (e.g. when July
// arrives the window becomes Feb–Jul instead of staying Jan–Jun).
exports.getMonthlyTrend = asyncHandler(async (req, res) => {
  const MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  // Build the list of the last 6 calendar months (oldest → newest),
  // anchored to the current month in the app timezone.
  const [yStr, mStr] = todayString().split('-');
  let year = parseInt(yStr, 10);
  let monthIdx = parseInt(mStr, 10) - 1; // 0-based

  const buckets = [];
  for (let i = 5; i >= 0; i--) {
    let m = monthIdx - i;
    let y = year;
    while (m < 0) {
      m += 12;
      y -= 1;
    }
    buckets.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, label: MONTH_NAMES[m], year: y });
  }

  // Start = first day of the oldest bucket, in the app timezone.
  const first = buckets[0];
  const rangeStart = startOfDay(new Date(`${first.key}-01T12:00:00Z`));

  // Group leads by their createdAt year-month, in the app timezone.
  const grouped = await Lead.aggregate([
    { $match: { tenantId: req.user.tenantId, createdAt: { $gte: rangeStart } } },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m',
            date: '$createdAt',
            timezone: APP_TZ,
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const countByKey = Object.fromEntries(grouped.map((g) => [g._id, g.count]));

  const trend = buckets.map((b) => ({
    label: b.label,
    year: b.year,
    count: countByKey[b.key] || 0,
  }));

  res.json({ trend });
});

// Admin Performance Dashboard — per-employee booking metrics
exports.getPerformanceDashboard = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const today = startOfDay();
  const todayEnd = endOfDay();
  const weekStart = startOfDaysAgo(7);
  // First day of the current month, anchored to the start of that local day.
  const [y, m] = todayString().split('-');
  const monthStart = startOfDay(new Date(`${y}-${m}-01T12:00:00Z`));

  const employees = await User.find({ tenantId, role: 'employee' })
    .select('-password')
    .sort({ name: 1 })
    .lean();
  const ids = employees.map((e) => e._id);

  // Single aggregation over all employees' leads instead of N queries per employee.
  const agg = await Lead.aggregate([
    { $match: { tenantId, assignedTo: { $in: ids } } },
    {
      $group: {
        _id: '$assignedTo',
        totalAssigned: { $sum: 1 },
        totalBooked: {
          $sum: { $cond: [{ $eq: ['$status', 'Booked'] }, 1, 0] },
        },
        assignedToday: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gte: ['$createdAt', today] },
                  { $lte: ['$createdAt', todayEnd] },
                ],
              },
              1,
              0,
            ],
          },
        },
        bookedToday: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', 'Booked'] },
                  { $gte: ['$updatedAt', today] },
                  { $lte: ['$updatedAt', todayEnd] },
                ],
              },
              1,
              0,
            ],
          },
        },
        weeklyBooked: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', 'Booked'] },
                  { $gte: ['$updatedAt', weekStart] },
                ],
              },
              1,
              0,
            ],
          },
        },
        monthlyBooked: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', 'Booked'] },
                  { $gte: ['$updatedAt', monthStart] },
                ],
              },
              1,
              0,
            ],
          },
        },
        previousPending: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', 'Pending'] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const byId = Object.fromEntries(agg.map((a) => [String(a._id), a]));

  const performanceData = employees.map((emp) => {
    const s = byId[String(emp._id)] || {};
    const totalAssigned = s.totalAssigned || 0;
    const totalBooked = s.totalBooked || 0;
    const conversionRate =
      totalAssigned > 0 ? Math.round((totalBooked / totalAssigned) * 100) : 0;

    return {
      employee: {
        _id: emp._id,
        name: emp.name,
        email: emp.email,
        isActive: emp.isActive,
      },
      assignedToday: s.assignedToday || 0,
      bookedToday: s.bookedToday || 0,
      previousPending: s.previousPending || 0,
      totalAssigned,
      totalBooked,
      weeklyBooked: s.weeklyBooked || 0,
      monthlyBooked: s.monthlyBooked || 0,
      conversionRate,
    };
  });

  res.json({ performance: performanceData });
});

// Get All Employees
exports.getEmployees = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const today = startOfDay();

  const employees = await User.find({ tenantId, role: 'employee' })
    .select('-password')
    .sort({ createdAt: -1 })
    .lean();
  const ids = employees.map((e) => e._id);

  // One aggregation instead of 2 queries per employee.
  const counts = await Lead.aggregate([
    { $match: { tenantId, assignedTo: { $in: ids } } },
    {
      $group: {
        _id: '$assignedTo',
        totalLeads: { $sum: 1 },
        todayLeads: {
          $sum: { $cond: [{ $gte: ['$createdAt', today] }, 1, 0] },
        },
      },
    },
  ]);
  const byId = Object.fromEntries(counts.map((c) => [String(c._id), c]));

  const employeesWithStats = employees.map((emp) => ({
    ...emp,
    totalLeads: byId[String(emp._id)]?.totalLeads || 0,
    todayLeads: byId[String(emp._id)]?.todayLeads || 0,
  }));

  res.json({ employees: employeesWithStats });
});

// Get Employee By ID
exports.getEmployeeById = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const employee = await User.findOne({ _id: req.params.id, tenantId }).select('-password');
  if (!employee) {
    return res.status(404).json({ message: 'Employee not found' });
  }

  const [y, m] = todayString().split('-');
  const monthStart = startOfDay(new Date(`${y}-${m}-01T12:00:00Z`));

  const [totalLeads, totalBooked, monthlyBooked, recentLeads] = await Promise.all([
    Lead.countDocuments({ tenantId, assignedTo: employee._id }),
    Lead.countDocuments({ tenantId, assignedTo: employee._id, status: 'Booked' }),
    Lead.countDocuments({ tenantId, assignedTo: employee._id, status: 'Booked', updatedAt: { $gte: monthStart } }),
    Lead.find({ tenantId, assignedTo: employee._id }).sort({ createdAt: -1 }).limit(10),
  ]);

  const conversionRate = totalLeads > 0 ? Math.round((totalBooked / totalLeads) * 100) : 0;

  res.json({ ...employee.toObject(), totalLeads, totalBooked, monthlyBooked, conversionRate, recentLeads });
});

// Add Employee
exports.addEmployee = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const { name, email, phone, password } = req.body;
  // FIX A: scope to tenantId — same email in a different org is fine
  const exists = await User.findOne({ email, tenantId });
  if (exists) {
    return res.status(400).json({ message: 'Email already exists' });
  }
  // New employee is always created under the SAME tenant as the admin
  // creating them — this is the one place an employee's tenantId is
  // ever set, so it can never be picked by the client/request body.
  const employee = await User.create({
    tenantId,
    name, email, phone,
    password: password || 'employee123',
    role: 'employee',
    isActive: true,
  });
  res.json({
    message: 'Employee added successfully',
    employee: { _id: employee._id, name: employee.name, email: employee.email }
  });
});

// Update Employee
exports.updateEmployee = asyncHandler(async (req, res) => {
  const { name, email, phone } = req.body;
  const result = await User.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.user.tenantId },
    { name, email, phone }
  );
  if (!result) return res.status(404).json({ message: 'Employee not found' });
  res.json({ message: 'Employee updated successfully' });
});

// Toggle Employee Status
exports.toggleEmployeeStatus = asyncHandler(async (req, res) => {
  const employee = await User.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  employee.isActive = !employee.isActive;
  await employee.save();
  res.json({
    message: `Employee ${employee.isActive ? 'activated' : 'deactivated'}`,
    isActive: employee.isActive
  });
});

// Get All Leads (Admin) — paginated archive/history
exports.getAllLeads = asyncHandler(async (req, res) => {
  const { search, status, employee, dateFrom, dateTo, month, year, page = 1, limit = 50 } = req.query;
  const { tenantId } = req.user;
  let filter = { tenantId };

  // Text search
  if (search) {
    const safe = escapeRegex(search.trim());
    const customDefs = await CustomFieldDefinition.find(
      { tenantId, isActive: true, type: { $in: ['text', 'select'] } },
      'key'
    );
    const customSearchClauses = customDefs.map((d) => ({
      [`customFields.${d.key}`]: { $regex: safe, $options: 'i' },
    }));
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { phone: { $regex: safe, $options: 'i' } },
      { city: { $regex: safe, $options: 'i' } },
      ...customSearchClauses,
    ];
  }

  // Status filter
  if (status) filter.status = status;

  // Employee filter
  if (employee) filter.assignedTo = employee;

  // Custom field filters — frontend sends them as customField_<key>=<value>
  // e.g. customField_package_type=Honeymoon (select)
  // e.g. customField_notes=urgent (text — partial match)
  // e.g. customField_amount=5000 (number — exact match)
  const customFieldEntries = Object.entries(req.query)
    .filter(([k]) => k.startsWith('customField_'));
  if (customFieldEntries.length > 0) {
    customFieldEntries.forEach(([k, v]) => {
      const key = k.replace('customField_', '');
      if (v) {
        // For text fields use case-insensitive partial match,
        // for select/number/date use exact match
        const numVal = Number(v);
        if (!isNaN(numVal) && v.trim() !== '') {
          filter[`customFields.${key}`] = numVal;
        } else {
          filter[`customFields.${key}`] = { $regex: escapeRegex(String(v)), $options: 'i' };
        }
      }
    });
  }

  // Date range filter.
  // FIX: previously used `new Date(dateFrom)` + `setHours(0,0,0,0)`/
  // `setHours(23,59,59,999)`, which compute midnight/end-of-day in the
  // SERVER's local timezone. On Render (UTC), that's 5:30 hours off from
  // the intended Asia/Kolkata day boundary, so a search for "today" or a
  // specific date could silently include/exclude leads from the wrong
  // side of midnight IST. Use the app's timezone-aware helpers instead.
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = startOfDay(new Date(`${dateFrom}T12:00:00Z`));
    if (dateTo) filter.createdAt.$lte = endOfDay(new Date(`${dateTo}T12:00:00Z`));
  }

  // Month + Year filter (overrides dateFrom/dateTo).
  // FIX: same timezone issue — `new Date(year, month-1, 1)` resolves in
  // the server's local time, not Asia/Kolkata. Anchor to noon UTC on the
  // 1st (always lands on the correct calendar date regardless of server
  // timezone) then convert to the IST day boundary.
  if (month && year) {
    const mm = String(parseInt(month, 10)).padStart(2, '0');
    const startDate = startOfDay(new Date(`${year}-${mm}-01T12:00:00Z`));
    const nextMonth = parseInt(month, 10) === 12 ? 1 : parseInt(month, 10) + 1;
    const nextYear = parseInt(month, 10) === 12 ? parseInt(year, 10) + 1 : parseInt(year, 10);
    const nextMm = String(nextMonth).padStart(2, '0');
    const endDate = new Date(
      startOfDay(new Date(`${nextYear}-${nextMm}-01T12:00:00Z`)).getTime() - 1
    );
    filter.createdAt = { $gte: startDate, $lte: endDate };
  } else if (year && !month) {
    const startDate = startOfDay(new Date(`${year}-01-01T12:00:00Z`));
    const endDate = new Date(
      startOfDay(new Date(`${parseInt(year, 10) + 1}-01-01T12:00:00Z`)).getTime() - 1
    );
    filter.createdAt = { $gte: startDate, $lte: endDate };
  }

  // Default archive window: last 30 days, UNLESS the admin is explicitly
  // searching/filtering. Older leads remain stored and reachable via search,
  // status, employee, or an explicit date/month/year range.
  const hasExplicitScope =
    search || status || employee || dateFrom || dateTo || month || year;
  if (!hasExplicitScope && !filter.createdAt) {
    filter.createdAt = { $gte: startOfDaysAgo(30) };
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [leads, total] = await Promise.all([
    Lead.find(filter)
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    Lead.countDocuments(filter),
  ]);

  res.json({ leads, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── Export Leads as CSV ────────────────────────────────────────────────────────
exports.exportLeadsCSV = asyncHandler(async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const { tenantId } = req.user;

  let filter = { tenantId };

  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = startOfDay(new Date(`${dateFrom}T12:00:00Z`));
    if (dateTo)   filter.createdAt.$lte = endOfDay(new Date(`${dateTo}T12:00:00Z`));
  }

  const [leads, customFieldDefs] = await Promise.all([
    Lead.find(filter)
      .populate('assignedTo', 'name')
      .sort({ createdAt: -1 })
      .lean(),
    CustomFieldDefinition.find({ tenantId, isActive: true }).sort({ order: 1 }).lean(),
  ]);

  // Build CSV header — fixed cols first, then custom fields (no status)
  const cfHeaders = customFieldDefs.map((f) => f.label);
  const headers = ['Name', 'Phone', 'Email', 'City', ...cfHeaders];

  const escape = (val) => {
    const str = val == null ? '' : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = [headers.join(',')];

  leads.forEach((lead) => {
    const cfValues = customFieldDefs.map((f) => {
      const val = lead.customFields instanceof Map
        ? lead.customFields.get(f.key)
        : lead.customFields?.[f.key];
      return escape(val ?? '');
    });

    rows.push([
      escape(lead.name ?? ''),
      escape(lead.phone ?? ''),
      escape(lead.email ?? ''),
      escape(lead.city ?? ''),
      ...cfValues,
    ].join(','));
  });

  const csv = rows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads_${dateFrom ?? 'all'}_to_${dateTo ?? 'all'}.csv"`);
  res.send(csv);
});

// Assign Lead
exports.assignLead = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const { employeeId } = req.body;
  const lead = await Lead.findOne({ _id: req.params.id, tenantId });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  const employee = await User.findOne({ _id: employeeId, tenantId }).select('_id name role isActive');
  if (!employee) {
    return res.status(404).json({ message: 'Employee not found' });
  }
  if (employee.role !== 'employee') {
    return res.status(400).json({ message: 'Leads can only be assigned to employees' });
  }
  if (!employee.isActive) {
    return res.status(400).json({ message: 'Cannot assign to an inactive employee' });
  }

  lead.assignedTo = employee._id;
  lead.timeline.push({
    type: 'assigned',
    description: `Lead assigned to ${employee.name}`,
  });
  await lead.save();

  res.json({ message: 'Lead assigned successfully' });
});

// ─── Appointments ────────────────────────────────────────────────────────────

// Get all appointments (admin view)
exports.getAppointments = asyncHandler(async (req, res) => {
  const appointments = await Appointment.find({ tenantId: req.user.tenantId })
    .populate({
      path: 'lead',
      select: 'name phone status assignedTo',
      populate: { path: 'assignedTo', select: 'name email' },
    })
    .populate('createdBy', 'name')
    .sort({ appointmentDate: 1, appointmentTime: 1 });

  // FIX: if a lead was deleted after its appointment was created, populate
  // returns lead: null for that record. The app screen reads
  // item.lead.name/.phone directly with no null guard, which crashes the
  // whole list (TypeError: Cannot read property 'name' of null). Filter
  // out orphaned appointments here so the API never returns a shape the
  // client can't safely render.
  const validAppointments = appointments.filter((a) => a.lead != null);

  res.json({ appointments: validAppointments, total: validAppointments.length });
});

// Get single appointment
exports.getAppointmentById = asyncHandler(async (req, res) => {
  const appointment = await Appointment.findOne({ _id: req.params.id, tenantId: req.user.tenantId })
    .populate({
      path: 'lead',
      select: 'name phone secondaryPhone email city status assignedTo',
      populate: { path: 'assignedTo', select: 'name email' },
    })
    .populate('createdBy', 'name');

  if (!appointment) {
    return res.status(404).json({ message: 'Appointment not found' });
  }

  res.json(appointment);
});

// Update appointment
exports.updateAppointment = asyncHandler(async (req, res) => {
  const { appointmentDate, appointmentTime, description } = req.body;
  const appointment = await Appointment.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.user.tenantId },
    { appointmentDate, appointmentTime, description },
    { new: true }
  ).populate({
    path: 'lead',
    select: 'name phone status assignedTo',
    populate: { path: 'assignedTo', select: 'name' },
  });

  if (!appointment) return res.status(404).json({ message: 'Appointment not found' });
  res.json({ message: 'Appointment updated', appointment });
});

// Set appointment status — 'scheduled' | 'completed' | 'missed'.
// Kept separate from updateAppointment (which only handles reschedule
// fields) so status changes have their own clear intent/endpoint, same
// as completeFollowUp is separate from generic follow-up edits.
// Does NOT touch the underlying Lead's status — appointment status and
// lead status are intentionally independent in this codebase.
const VALID_STATUSES = ['scheduled', 'completed', 'missed'];
exports.setAppointmentStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ message: `Status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  const appointment = await Appointment.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.user.tenantId },
    { status },
    { new: true }
  ).populate({
    path: 'lead',
    select: 'name phone status assignedTo',
    populate: { path: 'assignedTo', select: 'name' },
  });

  if (!appointment) return res.status(404).json({ message: 'Appointment not found' });
  res.json({ message: 'Appointment status updated', appointment });
});

// ── GET /admin/visitors ───────────────────────────────────────────────────────
// Upcoming visitor date leads — sirf wo leads jinki visitorDate aaj ya future mein hai
// Lead model mein visitorDate "DD MMM YYYY" format mein stored hai (e.g. "21 Aug 2026")
exports.getUpcomingVisitors = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;

  // Saare non-deleted leads jo is tenant ke hain aur visitorDate set hai
  const allLeads = await Lead.find({
    tenantId,
    isDeleted: false,
    visitorDate: { $nin: ['', null] },
  })
    .populate('assignedTo', 'name email')
    .sort({ visitorDate: 1 })
    .lean();

  // Today ki date "DD MMM YYYY" format mein (IST) — same format jisme stored hai
  const todayStr = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });

  // "02 Aug 2026" ko Date object mein convert karne ke liye
  const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  function parseVisitorDate(str) {
    if (!str) return null;
    const parts = str.trim().split(/\s+/);
    if (parts.length !== 3) return null;
    const [day, mon, year] = parts;
    const m = MONTHS[mon];
    if (m === undefined) return null;
    return new Date(+year, m, +day);
  }

  const todayDate = parseVisitorDate(todayStr);

  // Sirf upcoming (aaj + future) filter karo
  const upcoming = allLeads.filter((lead) => {
    const vd = parseVisitorDate(lead.visitorDate);
    if (!vd || !todayDate) return false;
    return vd >= todayDate;
  });

  res.json({ leads: upcoming, total: upcoming.length });
});

// ── PATCH /admin/visitors/:id/remove ─────────────────────────────────────────
// Lead delete nahi hogi — sirf visitorDate clear ho jaayegi
exports.removeFromVisitors = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;

  const lead = await Lead.findOne({ _id: req.params.id, tenantId, isDeleted: false });
  if (!lead) {
    return res.status(404).json({ message: 'Lead not found' });
  }

  lead.visitorDate = '';
  lead.timeline.push({
    type: 'status_changed',
    description: `Visitor date removed by ${req.user.name}`,
  });
  await lead.save();

  res.json({ message: 'Removed from visitors', leadId: lead._id });
});
