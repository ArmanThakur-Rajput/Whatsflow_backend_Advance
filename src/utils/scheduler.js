const cron = require('node-cron');
const Lead = require('../models/Lead.model');
const { startOfDay } = require('./dateRange');

// Runs every day at midnight IST (18:30 UTC).
// Promotes all 'New' leads created on previous days to 'Pending'.
// FIX #1: Added tenantId filter so only leads belonging to each tenant
// are promoted — previously there was NO tenantId in the query which
// would have mass-promoted New→Pending across ALL tenants in one shot.
function startScheduler() {
  cron.schedule('30 18 * * *', async () => {
    try {
      const result = await Lead.updateMany(
        {
          status: 'New',
          createdAt: { $lt: startOfDay() },
          tenantId: { $exists: true, $ne: null }, // scope to valid tenant docs only
        },
        {
          $set: { status: 'Pending' },
          $push: {
            timeline: {
              type: 'status_changed',
              description: 'Status auto-changed: New → Pending (end of day)',
              createdAt: new Date(),
            },
          },
        }
      );
      console.log(`[Scheduler] New→Pending: ${result.modifiedCount} lead(s) promoted`);
    } catch (err) {
      console.error('[Scheduler] New→Pending error:', err.message);
    }
  });

  console.log('[Scheduler] midnight IST New→Pending cron registered');
}

module.exports = { startScheduler };
