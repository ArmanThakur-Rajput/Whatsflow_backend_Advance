const mongoose = require('mongoose');

// One counter document PER TENANT (not a single global singleton like
// before). Each tenant's auto-assignment round-robin must cycle only
// through that tenant's own employees, completely independent of any
// other tenant's counter. _id is the tenant's Account _id directly —
// simplest possible 1:1 mapping, still atomically $inc-safe under
// concurrent lead creation for the same tenant.
const roundRobinSchema = new mongoose.Schema({
  _id:   { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
  index: { type: Number, default: 0 },
});

module.exports = mongoose.model('RoundRobinState', roundRobinSchema);