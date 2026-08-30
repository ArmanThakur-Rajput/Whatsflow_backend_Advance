const mongoose = require('mongoose');
const Lead = require('../models/Lead.model');
const User = require('../models/User.model');
const FollowUp = require('../models/FollowUp.model');
const asyncHandler = require('../utils/asyncHandler');
const { normalizePhone } = require('../middleware/leadValidators');
const { startOfDay, endOfDay, todayString, startOfMonth } = require('../utils/dateRange');
const { validateCustomFields } = require('../utils/customFields');
const CustomFieldDefinition = require('../models/CustomFieldDefinition.model');

// ─── helpers ─────────────────────────────────────────────────────────────────

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

async function findPhoneDuplicate(tenantId, primary, secondary, excludeLeadId = null) {
  const numbersToCheck = [primary];
  if (secondary) numbersToCheck.push(secondary);

  const orClauses = [
    { phone: { $in: numbersToCheck } },
    { secondaryPhone: { $in: numbersToCheck } },
  ];

  // Scoped to this tenant — the same phone number existing as a lead in
  // a DIFFERENT tenant is not a duplicate; it's just a different
  // business's customer who happens to share a phone number.
  const query = { tenantId, $or: orClauses };
  if (excludeLeadId) query._id = { $ne: excludeLeadId };

  return Lead.findOne(query).select('_id name phone secondaryPhone assignedTo');
}

async function getOwnedLead(req, res) {
  const { id } = req.params;

  if (!isValidId(id)) {
    res.status(404).json({ message: 'Lead not found' });
    return null;
  }

  // tenantId filter here means a lead belonging to a different tenant
  // returns "not found" rather than leaking its existence at all —
  // important for a multi-tenant app, where even confirming a record
  // exists is information that shouldn't cross tenant boundaries.
  const lead = await Lead.findOne({ _id: id, tenantId: req.user.tenantId });
  if (!lead) {
    res.status(404).json({ message: 'Lead not found' });
    return null;
  }

  if (
    req.user.role === 'employee' &&
    lead.assignedTo?.toString() !== req.user._id.toString()
  ) {
    res.status(403).json({ message: 'Access denied' });
    return null;
  }

  return lead;
}

// ─── controllers ─────────────────────────────────────────────────────────────

// GET /leads — list (employee sees only their own; admin sees all)
exports.getMyLeads = asyncHandler(async (req, res) => {
  const { role, _id, tenantId } = req.user;
  const { search, status, dateFrom, dateTo, page = 1, limit = 50 } = req.query;

  const filter = { tenantId, isDeleted: { $ne: true } };
  if (role === 'employee') filter.assignedTo = _id;
  if (status) filter.status = status;

  // Date range filter (used by admin for "today's leads", or any explicit
  // range request). Explicit dateFrom/dateTo always takes precedence.
  // FIX: setHours() used the server's local timezone (UTC in production),
  // not IST, so "today" leads created late at night IST fell outside the
  // window and silently vanished from the admin Leads tab. Anchor to noon
  // UTC (same convention as admin.controller.js) then use the IST-aware
  // startOfDay/endOfDay helpers, so the calendar date never shifts.
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = startOfDay(new Date(`${dateFrom}T12:00:00Z`));
    if (dateTo) filter.createdAt.$lte = endOfDay(new Date(`${dateTo}T12:00:00Z`));
  } else if (role === 'employee') {
    const todayStart = startOfDay();
    const todayEnd = endOfDay();

    if (status === 'New') {
      // New: only today's leads with status 'New'
      filter.createdAt = { $gte: todayStart, $lte: todayEnd };
    } else if (status === 'Booked') {
      // Booked chip: only leads booked today (updatedAt today)
      filter.updatedAt = { $gte: todayStart, $lte: todayEnd };
    } else if (!status) {
      // No filter (default view): today's window, exclude old booked
      filter.createdAt = { $gte: todayStart, $lte: todayEnd };
      filter.$or = [
        { status: { $ne: 'Booked' } },
        { status: 'Booked', updatedAt: { $gte: todayStart } },
      ];
    }
    // Interested / Contacted / Not Interested / Pending: all assigned leads, no date restriction
  }

  if (search) {
    const safe = escapeRegex(search);

    // Fetch active custom field keys for this tenant so we can search
    // each one individually — MongoDB Map fields need explicit key paths.
    const customDefs = await CustomFieldDefinition.find(
      { tenantId, isActive: true, type: { $in: ['text', 'select'] } },
      'key'
    );
    const customSearchClauses = customDefs.map((d) => ({
      [`customFields.${d.key}`]: { $regex: safe, $options: 'i' },
    }));

    const searchOr = [
      { name: { $regex: safe, $options: 'i' } },
      { phone: { $regex: safe, $options: 'i' } },
      { city: { $regex: safe, $options: 'i' } },
      ...customSearchClauses,
    ];
    // filter.$or may already be set above (employee today-scope booked
    // condition). Combine both conditions with $and instead of overwriting,
    // so search doesn't silently undo the today/booked-window scoping.
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
      delete filter.$or;
    } else {
      filter.$or = searchOr;
    }
  }

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const skip = (pageNum - 1) * limitNum;

  const [leads, total] = await Promise.all([
    Lead.find(filter)
      .populate('assignedTo', 'name email')
      .sort({ isPinned: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum),
    Lead.countDocuments(filter),
  ]);

  res.json({ leads, total, page: pageNum, limit: limitNum });
});

// GET /leads/:id
exports.getLeadById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(404).json({ message: 'Lead not found' });

  const lead = await Lead.findOne({ _id: id, tenantId: req.user.tenantId })
    .populate('assignedTo', 'name email')
    .populate('notes.createdBy', 'name');

  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  if (
    req.user.role === 'employee' &&
    lead.assignedTo?._id.toString() !== req.user._id.toString()
  ) {
    return res.status(403).json({ message: 'Access denied' });
  }

  res.json(lead);
});

// PATCH /leads/:id/status
exports.updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const lead = await getOwnedLead(req, res);
  if (!lead) return;

  // 'Deleted' is a reserved status only ever set by softDeleteLead/restoreLead
  // (so isDeleted/statusBeforeDelete/deletedAt stay in sync with it). Block
  // it here so a generic status-change call can't desync those fields.
  if (status === 'Deleted' || lead.isDeleted) {
    return res.status(400).json({
      message: lead.isDeleted
        ? 'Lead is deleted — restore it before changing status'
        : 'Use the delete action to remove a lead',
    });
  }

  const oldStatus = lead.status;
  lead.status = status;
  lead.statusUpdatedAt = new Date();
  lead.timeline.push({
    type: 'status_changed',
    description: `Status changed: ${oldStatus} → ${status}`,
  });
  await lead.save();

  res.json({ message: 'Status updated', status });
});

// PATCH /leads/:id/note
exports.addNote = asyncHandler(async (req, res) => {
  const { note } = req.body;
  const lead = await getOwnedLead(req, res);
  if (!lead) return;

  lead.notes.push({ content: note, createdBy: req.user._id });
  lead.timeline.push({
    type: 'note_added',
    description: `Note added: ${note.substring(0, 50)}`,
  });
  await lead.save();

  res.json({ message: 'Note saved' });
});

// PATCH /leads/:id/pin
exports.togglePin = asyncHandler(async (req, res) => {
  const lead = await getOwnedLead(req, res);
  if (!lead) return;

  lead.isPinned = !lead.isPinned;
  await lead.save();
  res.json({ isPinned: lead.isPinned });
});

// GET /leads/dashboard — Employee dashboard with Today's Leads + Previous Pending
exports.getDashboardStats = asyncHandler(async (req, res) => {
  const { role, _id, tenantId } = req.user;
  const filter = role === 'employee'
    ? { tenantId, assignedTo: _id, isDeleted: { $ne: true } }
    : { tenantId, isDeleted: { $ne: true } };

  // Today boundaries (app-timezone aware)
  const todayStart = startOfDay();
  const todayEnd = endOfDay();

  if (role === 'employee') {
    // Promote stale 'New' leads (created before today) to 'Pending' —
    // same logic as getEmployeePendingLeads so the count always matches.
    await Lead.updateMany(
      { tenantId, assignedTo: _id, status: 'New', createdAt: { $lt: todayStart } },
      {
        $set: { status: 'Pending', statusUpdatedAt: new Date() },
        $push: {
          timeline: {
            type: 'status_changed',
            description: 'Status auto-changed: New → Pending (end of day)',
          },
        },
      }
    );

    // Today's leads — assigned today, NOT booked before today, not deleted
    const todayLeadsQuery = {
      tenantId,
      assignedTo: _id,
      isDeleted: { $ne: true },
      createdAt: { $gte: todayStart, $lte: todayEnd },
      // Exclude leads that were booked on a previous day
      $or: [
        { status: { $ne: 'Booked' } },
        { status: 'Booked', updatedAt: { $gte: todayStart } },
      ],
    };

    // Pending leads — leads with status 'Pending'.
    // Kept identical to getEmployeePendingLeads so the dashboard count always
    // matches the list the employee actually opens.
    const pendingLeadsQuery = {
      tenantId,
      assignedTo: _id,
      status: 'Pending',
    };

    // Booked today (same day — still visible to employee)
    const bookedTodayQuery = {
      tenantId,
      assignedTo: _id,
      status: 'Booked',
      updatedAt: { $gte: todayStart, $lte: todayEnd },
    };

    // "My Lead Status" grid (Interested/Contacted/Not Interested/Pending/Total)
    // today's leads — matches the My Leads screen, which is also
    // today-scoped for employees. `todayFilter` mirrors `filter` but adds
    // the createdAt window.
    const todayFilter = { ...filter, createdAt: { $gte: todayStart, $lte: todayEnd } };

    // This calendar month's total leads (booked + unbooked) — used by the
    // "Month's Performance" card, separate from the today-scoped grid above.
    const monthStart = startOfMonth();
    const monthLeadsQuery = { ...filter, createdAt: { $gte: monthStart } };

    const [
      totalToday, interested, contacted, notInterested, bookedAllTime, totalAllTime,
      todayLeadsCount, previousPendingCount, bookedToday, todayFollowUps,
      monthLeadsCount,
    ] = await Promise.all([
      Lead.countDocuments(todayFilter),
      Lead.countDocuments({ ...todayFilter, status: 'Interested' }),
      Lead.countDocuments({ ...todayFilter, status: 'Contacted' }),
      Lead.countDocuments({ ...todayFilter, status: 'Not Interested' }),
      // Booked / total stay all-time
      Lead.countDocuments({ ...filter, status: 'Booked' }),
      Lead.countDocuments(filter),
      Lead.countDocuments(todayLeadsQuery),
      Lead.countDocuments(pendingLeadsQuery),
      Lead.countDocuments(bookedTodayQuery),
      FollowUp.countDocuments({
        tenantId,
        employee: _id,
        date: todayString(),
        isCompleted: false,
      }),
      Lead.countDocuments(monthLeadsQuery),
    ]);

    const conversionRate = totalAllTime > 0
      ? Math.round((bookedAllTime / totalAllTime) * 100)
      : 0;

    return res.json({
      totalLeads: totalToday,
      newToday: todayLeadsCount,
      interested,
      contacted,
      notInterested,
      booked: bookedAllTime,
      conversionRate,
      todayFollowUps,
      pending: previousPendingCount,
      todayLeadsCount,
      previousPendingCount,
      bookedToday,
      monthLeadsCount,
    });
  }

  // Admin path
  const [total, newToday, interested, contacted, notInterested, booked, followUps, pendingActive] =
    await Promise.all([
      Lead.countDocuments(filter),
      Lead.countDocuments({ ...filter, createdAt: { $gte: todayStart } }),
      Lead.countDocuments({ ...filter, status: 'Interested' }),
      Lead.countDocuments({ ...filter, status: 'Contacted' }),
      Lead.countDocuments({ ...filter, status: 'Not Interested' }),
      Lead.countDocuments({ ...filter, status: 'Booked' }),
      FollowUp.countDocuments({
        tenantId,
        date: todayString(),
        isCompleted: false,
      }),
      Lead.countDocuments({
        ...filter,
        status: 'Pending',
      }),
    ]);

  res.json({
    totalLeads: total, newToday,
    interested, contacted, notInterested, booked,
    todayFollowUps: followUps,
    pending: pendingActive,
  });
});

// GET /leads/employee-today — Employee: today's active leads list
exports.getEmployeeTodayLeads = asyncHandler(async (req, res) => {
  const { _id, tenantId } = req.user;
  const todayStart = startOfDay();
  const todayEnd = endOfDay();

  const leads = await Lead.find({
    tenantId,
    assignedTo: _id,
    isDeleted: { $ne: true },
    createdAt: { $gte: todayStart, $lte: todayEnd },
    $or: [
      { status: { $ne: 'Booked' } },
      { status: 'Booked', updatedAt: { $gte: todayStart } },
    ],
  })
    .populate('assignedTo', 'name email')
    .sort({ isPinned: -1, statusUpdatedAt: -1 });

  res.json({ leads, total: leads.length });
});

// GET /leads/employee-pending — Leads with status 'Pending'
// Also auto-promotes any 'New' leads from previous days to 'Pending' on fetch.
exports.getEmployeePendingLeads = asyncHandler(async (req, res) => {
  const { _id, tenantId } = req.user;
  const todayStart = startOfDay();

  // Promote stale 'New' leads (created before today) to 'Pending'
  await Lead.updateMany(
    { tenantId, assignedTo: _id, status: 'New', createdAt: { $lt: todayStart } },
    {
      $set: { status: 'Pending', statusUpdatedAt: new Date() },
      $push: {
        timeline: {
          type: 'status_changed',
          description: 'Status auto-changed: New → Pending (end of day)',
        },
      },
    }
  );

  const leads = await Lead.find({
    tenantId,
    assignedTo: _id,
    status: 'Pending',
  })
    .populate('assignedTo', 'name email')
    .sort({ isPinned: -1, createdAt: -1 });

  res.json({ leads, total: leads.length });
});

// GET /leads/employee-booked — Employee: booked leads.
// ?scope=today (default) = booked today only. ?scope=all = every booked
// lead regardless of date, for the dashboard's "All Booked" card.
exports.getEmployeeBookedLeads = asyncHandler(async (req, res) => {
  const { _id, tenantId } = req.user;
  const { scope = 'today' } = req.query;

  const filter = { tenantId, assignedTo: _id, status: 'Booked' };

  if (scope === 'today') {
    const todayStart = startOfDay();
    const todayEnd = endOfDay();
    filter.updatedAt = { $gte: todayStart, $lte: todayEnd };
  }
  // scope === 'all' -> no date restriction, every booked lead ever assigned.

  const leads = await Lead.find(filter)
    .populate('assignedTo', 'name email')
    .sort({ isPinned: -1, updatedAt: -1 });

  res.json({ leads, total: leads.length, scope });
});

// POST /leads — create lead (both admin and employee)
exports.createLead = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const {
    name, primaryPhone, secondaryPhone,
    email, city, source, campaign, car,
    assignedTo, status, customFields,
  } = req.body;

  const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

  const primary = normalizePhone(primaryPhone);
  const secondary = secondaryPhone ? normalizePhone(secondaryPhone) : '';

  const duplicate = await findPhoneDuplicate(tenantId, primary, secondary);
  if (duplicate) {
    return res.status(409).json({
      message: 'Lead already exists with this phone number.',
      conflictLead: {
        id: duplicate._id,
        name: duplicate.name,
        phone: duplicate.phone,
      },
    });
  }

  // Validate this tenant's admin-defined custom fields (e.g. a tour
  // operator's "Package Type", a bank's "Loan Amount") before creating
  // the lead — requireAll=true here, since this is a brand-new lead and
  // every field the admin marked required must be filled at creation.
  const { values: customFieldValues, error: customFieldError } =
    await validateCustomFields(tenantId, customFields, true);
  if (customFieldError) {
    return res.status(400).json({ message: customFieldError });
  }

  let assignee = null;
  if (req.user.role === 'admin') {
    if (assignedTo) {
      if (!isValidId(assignedTo)) {
        return res.status(400).json({ message: 'Invalid assignedTo employee ID' });
      }
      // Scoped to this tenant so an admin can never assign a lead to
      // another business's employee, even by guessing/reusing an ID.
      const emp = await User.findOne({ _id: assignedTo, tenantId }).select('_id role isActive');
      if (!emp) {
        return res.status(400).json({ message: 'Assigned employee not found' });
      }
      if (emp.role !== 'employee') {
        return res.status(400).json({ message: 'assignedTo must be an employee, not admin' });
      }
      assignee = emp._id;
    }
  } else {
    assignee = req.user._id;
  }

// Employees cannot set status on create — it always starts as 'New'.
  // Only admins can pre-set a status (e.g. importing a lead that's
  // already been contacted via another channel).
  const initialStatus = req.user.role === 'admin' && status ? status : 'New';

const lead = await Lead.create({
    tenantId,
    name: clip(name, 120),
    phone: primary,
    secondaryPhone: secondary,
    email: clip(email, 120),
    city: clip(city, 80),
    source: clip(source, 40) || 'Manual',
    campaign: clip(campaign, 120),
    car: clip(car, 80),
    customFields: customFieldValues,
    status: initialStatus,
    assignedTo: assignee,
    timeline: [{
      type: 'created',
      description: (clip(source, 40) || 'Manual') === 'WhatsApp'
        ? 'Lead received via WhatsApp'
        : `Lead created manually by ${req.user.name}` + (assignee ? '' : ' (unassigned)')
          + (initialStatus !== 'New' ? ` — status set to ${initialStatus}` : ''),
    }],
  });

  await lead.populate('assignedTo', 'name email');

  res.status(201).json({ message: 'Lead created successfully', lead });
});


// POST /leads/:id/followup
exports.addFollowUp = asyncHandler(async (req, res) => {
  const { date, time, notes } = req.body;
  const lead = await getOwnedLead(req, res);
  if (!lead) return;

  const followUp = await FollowUp.create({
    tenantId: req.user.tenantId,
    lead: lead._id,
    employee: req.user._id,
    date, time, notes,
  });

  lead.timeline.push({
    type: 'followup_added',
    description: `Follow-up scheduled for ${date} at ${time}`,
  });
  await lead.save();

  res.json({ message: 'Follow-up saved', followUp });
});

// GET /leads/followups/today
exports.getTodayFollowUps = asyncHandler(async (req, res) => {
  const today = todayString();
  const followUps = await FollowUp.find({
    tenantId: req.user.tenantId,
    employee: req.user._id,
    date: today,
    isCompleted: false,
  }).populate('lead', 'name phone status');

  res.json({ followUps, total: followUps.length });
});

// GET /leads/followups/all  (admin — all employees, all dates, not completed)
exports.getAllFollowUps = asyncHandler(async (req, res) => {
  const followUps = await FollowUp.find({
    tenantId: req.user.tenantId,
    isCompleted: false,
  })
    .populate('lead', 'name phone status')
    .populate('employee', 'name email')
    .sort({ date: 1, time: 1 });

  res.json({ followUps, total: followUps.length });
});

// PATCH /leads/followup/:followUpId/complete
exports.completeFollowUp = asyncHandler(async (req, res) => {
  const followUp = await FollowUp.findOne({ _id: req.params.followUpId, tenantId: req.user.tenantId });
  if (!followUp) return res.status(404).json({ message: 'Follow-up not found' });
  if (followUp.employee.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: 'Access denied' });
  }

  followUp.isCompleted = true;
  await followUp.save();
  res.json({ message: 'Follow-up marked complete', followUp });
});

// PATCH /leads/:id/info
exports.updateLeadInfo = asyncHandler(async (req, res) => {
  const { name, phone, email, city, car, campaign, customFields } = req.body;
  const lead = await getOwnedLead(req, res);
  if (!lead) return;

  if (phone) {
    const normalised = normalizePhone(phone);
    if (!/^\d{10}$/.test(normalised)) {
      return res.status(400).json({ message: 'Phone must be exactly 10 digits (no country code)' });
    }
    const dup = await findPhoneDuplicate(req.user.tenantId, normalised, '', lead._id);
    if (dup) {
      return res.status(409).json({ message: 'Another lead already has this phone number.' });
    }
    lead.phone = normalised;
  }

  if (name !== undefined) lead.name = name;
  if (email !== undefined) lead.email = email;
  if (city !== undefined) lead.city = city;
  if (car !== undefined) lead.car = car;
  if (campaign !== undefined) lead.campaign = campaign;

  // Editing an existing lead — requireAll=false, since this is a
  // partial update. Only the fields actually submitted get validated
  // and merged in; fields the admin didn't touch keep their existing
  // saved value untouched.
  if (customFields !== undefined) {
    const { values: customFieldValues, error: customFieldError } =
      await validateCustomFields(req.user.tenantId, customFields, false);
    if (customFieldError) {
      return res.status(400).json({ message: customFieldError });
    }
    for (const [key, value] of customFieldValues) {
      lead.customFields.set(key, value);
    }
  }

  lead.timeline.push({
    type: 'status_changed',
    description: `Lead info updated by ${req.user.name}`,
  });

  await lead.save();
  res.json({ message: 'Lead updated successfully', lead });
});
// PATCH /leads/:id/soft-delete
// Soft-deletes a lead — sets status='Deleted', isDeleted=true, and stores
// the prior status in statusBeforeDelete so it can be restored later.
// Only the assigned employee can soft-delete. Booked leads cannot be deleted.
exports.softDeleteLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  // Only assigned employee can delete
  if (
    req.user.role === 'employee' &&
    lead.assignedTo?.toString() !== req.user._id.toString()
  ) {
    return res.status(403).json({ message: 'Access denied' });
  }

  // Cannot delete Booked leads
  if (lead.status === 'Booked') {
    return res.status(400).json({ message: 'Booked leads cannot be deleted' });
  }

  // Already deleted
  if (lead.isDeleted) {
    return res.status(400).json({ message: 'Lead is already deleted' });
  }

  lead.statusBeforeDelete = lead.status;
  lead.status = 'Deleted';
  lead.isDeleted = true;
  lead.deletedAt = new Date();
  lead.deletedBy = req.user._id;
  lead.timeline.push({
    type: 'status_changed',
    description: `Lead soft-deleted by ${req.user.name}`,
  });

  await lead.save();
  res.json({ message: 'Lead removed successfully', lead });
});

// PATCH /leads/:id/restore
// Restores a soft-deleted lead back to its previous status.
exports.restoreLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, tenantId: req.user.tenantId });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  if (
    req.user.role === 'employee' &&
    lead.assignedTo?.toString() !== req.user._id.toString()
  ) {
    return res.status(403).json({ message: 'Access denied' });
  }

  if (!lead.isDeleted) {
    return res.status(400).json({ message: 'Lead is not deleted' });
  }

  lead.status = lead.statusBeforeDelete || 'New';
  lead.statusUpdatedAt = new Date();
  lead.isDeleted = false;
  lead.deletedAt = null;
  lead.deletedBy = null;
  lead.statusBeforeDelete = null;
  lead.timeline.push({
    type: 'status_changed',
    description: `Lead restored by ${req.user.name}`,
  });

  await lead.save();
  res.json({ message: 'Lead restored successfully', lead });
});

// GET /leads/employee-archive
// Returns ALL leads ever assigned to the employee (including soft-deleted).
// Supports optional ?status= filter.
exports.getEmployeeArchive = asyncHandler(async (req, res) => {
  const { _id, tenantId } = req.user;
  const { status, search } = req.query;

  const filter = { tenantId, assignedTo: _id };
  if (status && status !== 'all') filter.status = status;
  if (search) {
    const safe = escapeRegex(String(search));
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { phone: { $regex: safe, $options: 'i' } },
    ];
  }

  const leads = await Lead.find(filter)
    .populate('assignedTo', 'name email')
    .sort({ isPinned: -1, updatedAt: -1 });

  res.json({ leads, total: leads.length });
});

// GET /leads/:id/appointment
// Fetch the appointment for a specific lead (if any).
exports.getLeadAppointment = asyncHandler(async (req, res) => {
  const Appointment = require('../models/Appointment.model');
  const appointment = await Appointment.findOne({ lead: req.params.id, tenantId: req.user.tenantId })
    .populate('createdBy', 'name')
    .sort({ createdAt: -1 });

  if (!appointment) return res.status(404).json({ message: 'No appointment found' });
  res.json({ appointment });
});


// PATCH /leads/:id/visitor-date
// Sets or updates the visitor date (and optional time) for a lead.
// Both employee (assigned to this lead) and admin can call this.
exports.updateVisitorDate = asyncHandler(async (req, res) => {
  const { visitorDate, visitorTime } = req.body;
  if (!visitorDate) {
    return res.status(400).json({ message: 'visitorDate is required' });
  }

  const lead = await getOwnedLead(req, res);
  if (!lead) return;

  lead.visitorDate = visitorDate;
  // visitorTime optional hai — null bhejne par clear ho jata hai
  lead.visitorTime = visitorTime || '';

  const timeLabel = visitorTime ? ` at ${visitorTime}` : '';
  lead.timeline.push({
    type: 'status_changed',
    description: `Visitor date set to ${visitorDate}${timeLabel} by ${req.user.name}`,
  });

  await lead.save();
  res.json({
    message: 'Visitor date updated',
    visitorDate: lead.visitorDate,
    visitorTime: lead.visitorTime,
  });
});
