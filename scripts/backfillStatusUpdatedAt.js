/**
 * Migration: Backfill statusUpdatedAt for existing leads
 *
 * The Lead model now has a `statusUpdatedAt` field, used to sort the
 * employee "My Leads" list (so a lead only jumps to the top of its filter
 * on an actual status change or new-lead creation — not on every save,
 * like viewing details, pinning, adding a note, etc.).
 *
 * Mongoose schema defaults only apply to NEW documents. Leads created
 * before this field existed have no statusUpdatedAt at all, which sorts
 * as missing/null — pushing every pre-existing lead to the bottom of the
 * list, regardless of how recently its status actually changed.
 *
 * This backfills statusUpdatedAt = createdAt for any lead missing it,
 * which is the best available approximation (their status hasn't been
 * explicitly changed since this field started being tracked, so
 * "creation time" is the most accurate stand-in for "last status change").
 *
 * Run once: node scripts/backfillStatusUpdatedAt.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌  No MONGO_URI found in .env');
  process.exit(1);
}

async function migrate() {
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected to MongoDB');

  const Lead = mongoose.connection.collection('leads');

  const missing = await Lead.countDocuments({ statusUpdatedAt: { $exists: false } });
  console.log(`Found ${missing} lead(s) missing statusUpdatedAt`);

  if (missing === 0) {
    console.log('✅  Nothing to migrate');
    await mongoose.disconnect();
    return;
  }

  // $set with an aggregation pipeline update so each document gets ITS OWN
  // createdAt value, not one fixed Date for every document.
  const result = await Lead.updateMany(
    { statusUpdatedAt: { $exists: false } },
    [{ $set: { statusUpdatedAt: '$createdAt' } }]
  );

  console.log(`✅  Migration complete: ${result.modifiedCount} lead(s) backfilled`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
});
