const mongoose = require('mongoose');
const Lead = require('../models/Lead.model');
const asyncHandler = require('../utils/asyncHandler');
const {
  normalizeVisitorDate,
  parseDateParts,
  parseTimeParts,
  visitAtUTC,
  deriveVisitState,
} = require('../utils/visitStatus');

const VALID_FILTERS = ['all', 'awaiting', 'upcoming', 'completed', 'cancelled'];
const MAX_TEXT = 1000;

// ── GET /api/visitors?status=all|awaiting|upcoming|completed|cancelled ──────
// Admin  → every visitor lead of the tenant.
// Employee → only visitor leads assigned to them.
//
// Response:
// {
//   leads: [{ ...lead, visitState, visitAt }],   // visitState = awaiting|upcoming|completed|cancelled
//   counts: { awaiting, upcoming, today, completed, cancelled, total }
// }
exports.listVisitors = asyncHandler(async (req, res) => {
  const { tenantId, role, _id } = req.user;
  const filter = String(req.query.status || 'all').toLowerCase();
  if (!VALID_FILTERS.includes(filter)) {
    return res.status(400).json({ message: `status must be one of: ${VALID_FILTERS.join(', ')}` });
  }

  const query = { tenantId, isDeleted: false, visitorDate: { $nin: ['', null] } };
  if (role === 'employee') query.assignedTo = _id;

  const raw = await Lead.find(query)
    .select('name phone secondaryPhone city source status assignedTo visitorDate visitorTime ' +
            'visitStatus visitPromptSent visitOutcome visitHistory')
    .populate('assignedTo', 'name')
    .lean();

  const now = Date.now();
  const todayEnd = (() => {
    const ist = new Date(now + 5.5 * 3600000);
    return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - 5.5 * 3600000;
  })();

  const counts = { awaiting: 0, upcoming: 0, today: 0, completed: 0, cancelled: 0, total: 0 };
  const leads = [];

  for (const l of raw) {
    const at = visitAtUTC(l.visitorDate, l.visitorTime);
    if (!at) continue; // unparseable date — skip rather than crash
    const visitState = deriveVisitState(l, now);
    counts[visitState] += 1;
    counts.total += 1;
    if (visitState === 'upcoming' && at.getTime() < todayEnd) counts.today += 1;
    if (filter === 'all' || filter === visitState) {
      leads.push({ ...l, visitState, visitAt: at.toISOString() });
    }
  }

  // awaiting first (needs action, oldest first) → upcoming (soonest first)
  // → completed/cancelled (most recent first)
  const rank = { awaiting: 0, upcoming: 1, completed: 2, cancelled: 2 };
  leads.sort((a, b) => {
    if (rank[a.visitState] !== rank[b.visitState]) return rank[a.visitState] - rank[b.visitState];
    const d = new Date(a.visitAt) - new Date(b.visitAt);
    return rank[a.visitState] >= 2 ? -d : d;
  });

  res.json({ leads, counts });
});

// ── PATCH /api/visitors/:id/outcome ──────────────────────────────────────────
// body:
//   { action: 'completed',   details?: string }
//   { action: 'rescheduled', visitorDate: 'DD MMM YYYY', visitorTime: 'hh:mm AM', note?: string }
//   { action: 'cancelled',   reason: string }           (reason required)
exports.setVisitOutcome = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).json({ message: 'Lead not found' });
  }

  const lead = await Lead.findOne({ _id: id, tenantId: req.user.tenantId, isDeleted: false });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  if (req.user.role === 'employee' && lead.assignedTo?.toString() !== req.user._id.toString()) {
    return res.status(403).json({ message: 'Access denied' });
  }

  if (!lead.visitorDate) {
    return res.status(400).json({ message: 'This lead has no visit scheduled' });
  }
  const current = lead.visitStatus || 'upcoming';
  if (current !== 'upcoming') {
    return res.status(409).json({ message: `Visit is already ${current}` });
  }

  const { action } = req.body;
  const clip = (v) => String(v || '').trim().slice(0, MAX_TEXT);
  const by = req.user._id;
  const byName = req.user.name || '';

  if (action === 'completed') {
    const details = clip(req.body.details);
    lead.visitStatus = 'completed';
    lead.visitOutcome = { details, cancelReason: '', closedAt: new Date(), closedBy: by };
    lead.visitHistory.push({
      action: 'completed', date: lead.visitorDate, time: lead.visitorTime || '',
      note: details, by, byName,
    });
    lead.timeline.push({
      type: 'visit_update',
      description: `Visit completed by ${byName}${details ? ` — ${details}` : ''}`,
    });

  } else if (action === 'rescheduled') {
    const newDate = normalizeVisitorDate(req.body.visitorDate);
    const newTime = String(req.body.visitorTime || '').trim();
    if (!parseDateParts(newDate)) {
      return res.status(400).json({ message: 'visitorDate must look like "21 Aug 2026"' });
    }
    if (!parseTimeParts(newTime)) {
      return res.status(400).json({ message: 'visitorTime is required, like "10:30 AM"' });
    }
    const at = visitAtUTC(newDate, newTime);
    if (at.getTime() <= Date.now()) {
      return res.status(400).json({ message: 'New visit date/time must be in the future' });
    }
    const note = clip(req.body.note);
    const prevDate = lead.visitorDate;
    const prevTime = lead.visitorTime || '';

    lead.visitorDate = newDate;
    lead.visitorTime = newTime;
    lead.visitStatus = 'upcoming';
    lead.visitPromptSent = false;           // ask again after the NEW time passes
    lead.visitOutcome = undefined;
    lead.visitHistory.push({
      action: 'rescheduled', date: newDate, time: newTime, prevDate, prevTime,
      note, by, byName,
    });
    lead.timeline.push({
      type: 'visit_update',
      description: `Visit rescheduled from ${prevDate}${prevTime ? ' ' + prevTime : ''} ` +
                   `to ${newDate} ${newTime} by ${byName}`,
    });

  } else if (action === 'cancelled') {
    const reason = clip(req.body.reason);
    if (reason.length < 3) {
      return res.status(400).json({ message: 'Please enter the reason for cancelling' });
    }
    lead.visitStatus = 'cancelled';
    lead.visitOutcome = { details: '', cancelReason: reason, closedAt: new Date(), closedBy: by };
    lead.visitHistory.push({
      action: 'cancelled', date: lead.visitorDate, time: lead.visitorTime || '',
      note: reason, by, byName,
    });
    lead.timeline.push({
      type: 'visit_update',
      description: `Visit cancelled by ${byName} — ${reason}`,
    });

  } else {
    return res.status(400).json({ message: "action must be 'completed', 'rescheduled' or 'cancelled'" });
  }

  await lead.save();
  res.json({
    message: 'Visit updated',
    leadId: lead._id,
    visitStatus: lead.visitStatus,
    visitorDate: lead.visitorDate,
    visitorTime: lead.visitorTime,
    visitOutcome: lead.visitOutcome,
  });
});
