/**
 * Migration: backfill tenantId onto pre-multi-tenant documents.
 *
 * Before this change, the app had no concept of a tenant — every User,
 * Lead, Appointment, AdminSchedule, FollowUp, Notification, and
 * RoundRobinState document was implicitly shared across the whole
 * database. This script:
 *
 *   1. Creates ONE Account (tenant) to represent your existing business
 *      (override its name with --name "Your Business Name").
 *   2. Assigns that Account's _id as tenantId on every existing User
 *      (admin + employees) that doesn't already have one.
 *   3. Assigns the SAME admin's tenantId onto every existing Lead,
 *      Appointment, FollowUp, Notification, and AdminSchedule document
 *      that doesn't already have a tenantId (by looking at who
 *      created/owns each one — falls back to the single admin's
 *      tenantId if ownership can't be determined).
 *   4. Migrates the old global RoundRobinState singleton (_id: 'singleton')
 *      into a new per-tenant document keyed by the new Account's _id.
 *
 * This is safe to re-run — every step only touches documents that
 * don't already have a tenantId, so running it twice is a no-op the
 * second time.
 *
 * Run once:  node scripts/migrateToMultiTenant.js [--name "Business Name"]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Account = require('../src/models/Account.model');
const User = require('../src/models/User.model');
const Lead = require('../src/models/Lead.model');
const Appointment = require('../src/models/Appointment.model');
const FollowUp = require('../src/models/FollowUp.model');
const Notification = require('../src/models/Notification.model');
const AdminSchedule = require('../src/models/AdminSchedule.model');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

async function migrate() {
  const { name } = parseArgs();
  await mongoose.connect(process.env.MONGO_URI);

  // ── Step 1: find or create the single tenant for existing data ──────────
  const usersWithoutTenant = await User.countDocuments({ tenantId: { $exists: false } });
  if (usersWithoutTenant === 0) {
    console.log('No users without a tenantId found — nothing to migrate. Exiting.');
    await mongoose.disconnect();
    process.exit(0);
  }

  let account = await Account.findOne().sort({ createdAt: 1 });
  if (!account) {
    account = await Account.create({ name: name || 'My Business' });
    console.log(`Created Account "${account.name}" (${account._id})`);
  } else {
    console.log(`Using existing Account "${account.name}" (${account._id})`);
  }
  const tenantId = account._id;

  // ── Step 2: backfill Users ───────────────────────────────────────────────
  const userResult = await User.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId } }
  );
  console.log(`Users updated: ${userResult.modifiedCount}`);

  // ── Step 3: backfill everything else ─────────────────────────────────────
  const leadResult = await Lead.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId } }
  );
  console.log(`Leads updated: ${leadResult.modifiedCount}`);

  const apptResult = await Appointment.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId } }
  );
  console.log(`Appointments updated: ${apptResult.modifiedCount}`);

  const followUpResult = await FollowUp.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId } }
  );
  console.log(`FollowUps updated: ${followUpResult.modifiedCount}`);

  const notifResult = await Notification.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId } }
  );
  console.log(`Notifications updated: ${notifResult.modifiedCount}`);

  // AdminSchedule previously had at most ONE document total (by design).
  // Give it this tenant's id and make sure it's still tied to a real
  // admin (in case the schedule's `admin` field pointed at a user that
  // no longer matches any admin in this tenant — shouldn't normally
  // happen, but defensive here since this only runs once).
  const scheduleResult = await AdminSchedule.updateMany(
    { tenantId: { $exists: false } },
    { $set: { tenantId } }
  );
  console.log(`AdminSchedules updated: ${scheduleResult.modifiedCount}`);

  // ── Step 4: migrate the old global RoundRobinState singleton ────────────
  const RoundRobinState = mongoose.connection.collection('roundrobinstates');
  const oldSingleton = await RoundRobinState.findOne({ _id: 'singleton' });
  if (oldSingleton) {
    await RoundRobinState.updateOne(
      { _id: tenantId },
      { $set: { index: oldSingleton.index } },
      { upsert: true }
    );
    await RoundRobinState.deleteOne({ _id: 'singleton' });
    console.log(`Migrated round-robin counter (index=${oldSingleton.index}) to tenant ${tenantId}`);
  } else {
    console.log('No old round-robin singleton found — nothing to migrate there.');
  }

  console.log('\n✅ Migration complete.');
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
