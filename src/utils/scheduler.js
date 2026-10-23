const cron = require('node-cron');
const Lead = require('../models/Lead.model');
const { startOfDay } = require('./dateRange');
const { sendPendingRequestReminders } = require('../controllers/propertyRequests.controller');

// ── 1. New → Pending lead promoter — midnight IST (18:30 UTC) ─────────────────
// Promotes all 'New' leads created on previous days to 'Pending'.
function startScheduler() {
  cron.schedule('30 18 * * *', async () => {
    try {
      const result = await Lead.updateMany(
        {
          status: 'New',
          createdAt: { $lt: startOfDay() },
          tenantId: { $exists: true, $ne: null },
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

  // ── 2. Pending property-request daily reminder — 10:00 AM IST (04:30 UTC) ──
  // Fires every day while a request_notif doc stays status=pending.
  // Sends push + in-app notification to all admins of that tenant.
  cron.schedule('30 4 * * *', async () => {
    console.log('[Scheduler] Running pending property-request reminders…');
    await sendPendingRequestReminders();
  });

  console.log('[Scheduler] All crons registered (midnight IST + 10 AM IST)');
}

module.exports = { startScheduler };
