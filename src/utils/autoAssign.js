const User = require('../models/User.model');
const RoundRobinState = require('../models/RoundRobinState.model');

/**
 * Returns the next active employee ID for the given tenant, using
 * round-robin. Uses atomic findOneAndUpdate ($inc) so concurrent leads
 * for the SAME tenant never get assigned to the same employee by
 * mistake. The round-robin counter itself is keyed by tenantId, so two
 * different tenants' counters never interfere with each other.
 *
 * FIX #4: Added retry logic around the upsert. When two concurrent lead
 * creations for a brand-new tenant both reach findOneAndUpdate before
 * the doc exists, MongoDB can throw an E11000 duplicate-key error instead
 * of merging. We catch that specific error and retry once — on the
 * second attempt the doc already exists so the $inc succeeds cleanly.
 *
 * Returns null if no active employees exist for this tenant.
 */
async function getNextEmployee(tenantId) {
  const employees = await User.find(
    { tenantId, role: 'employee', isActive: true },
    '_id'
  ).sort({ createdAt: 1 }); // stable order — oldest first

  if (!employees.length) return null;

  const total = employees.length;

  const upsertCounter = async () => {
    return RoundRobinState.findOneAndUpdate(
      { _id: tenantId },
      { $inc: { index: 1 } },
      { upsert: true, new: false } // new:false → returns doc BEFORE increment
    );
  };

  let state;
  try {
    state = await upsertCounter();
  } catch (err) {
    // E11000 = duplicate key — two concurrent upserts for a brand-new tenant.
    // The winner already created the doc, so a plain retry will succeed.
    if (err.code === 11000) {
      state = await upsertCounter();
    } else {
      throw err;
    }
  }

  const currentIndex = state ? state.index : 0;
  const assignedEmployee = employees[currentIndex % total];

  return assignedEmployee._id;
}

module.exports = { getNextEmployee };
