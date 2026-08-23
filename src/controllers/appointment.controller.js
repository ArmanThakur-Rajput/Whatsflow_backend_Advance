const mongoose = require('mongoose');
const Appointment = require('../models/Appointment.model');
const Lead = require('../models/Lead.model');
const asyncHandler = require('../utils/asyncHandler');

// Create appointment — used by EMPLOYEE when marking a lead as "Booked".
// Employee can only book an appointment for a lead assigned to them.
// Admin can also call this (e.g. booking on behalf of an employee).
exports.createAppointment = asyncHandler(async (req, res) => {
  const { tenantId } = req.user;
  const { leadId, appointmentDate, appointmentTime, description } = req.body;
  const lead = await Lead.findOne({ _id: leadId, tenantId });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  // Employees can only book appointments for their own assigned leads
  if (
    req.user.role === 'employee' &&
    lead.assignedTo?.toString() !== req.user._id.toString()
  ) {
    return res.status(403).json({ message: 'You can only book appointments for your own leads' });
  }

  // FIX: the slot picker on the client is only a UI hint — without a
  // server-side check, two employees (or a stale client) could both
  // submit the same date+time and double-book the same slot. Reject it
  // here regardless of what the client believed was free.
  // Scoped to this tenant — two different businesses booking the same
  // calendar date+time is completely normal and must not conflict.
  const conflict = await Appointment.findOne({ tenantId, appointmentDate, appointmentTime });
  if (conflict) {
    return res.status(409).json({ message: 'This time slot has just been booked. Please pick another.' });
  }

  // FIX: lead.save() and Appointment.create() used to be two independent
  // writes. If Appointment.create() failed for any reason after the lead
  // was already saved as 'Booked', the lead was left stuck in a 'Booked'
  // state with no appointment behind it. Wrapping both writes in a
  // transaction means either both succeed together or neither does.
  const session = await mongoose.startSession();
  let appointment;
  try {
    await session.withTransaction(async () => {
      lead.status = 'Booked';
      lead.statusUpdatedAt = new Date();
      lead.timeline.push({
        type: 'appointment_set',
        description: `Appointment booked for ${appointmentDate} at ${appointmentTime} by ${req.user.name}`,
      });
      await lead.save({ session });

      appointment = await Appointment.create(
        [{
          tenantId,
          lead: leadId,
          appointmentDate,
          appointmentTime,
          description: description || '',
          createdBy: req.user._id,
        }],
        { session }
      );
      appointment = appointment[0]; // create() with an array + session returns an array
    });
  } finally {
    await session.endSession();
  }

  const populated = await appointment.populate([
    { path: 'lead', select: 'name phone status assignedTo', populate: { path: 'assignedTo', select: 'name' } },
    { path: 'createdBy', select: 'name' },
  ]);

  res.status(201).json({ message: 'Appointment created successfully', appointment: populated });
});