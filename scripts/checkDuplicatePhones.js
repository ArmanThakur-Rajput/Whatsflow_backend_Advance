/**
 * checkDuplicatePhones.js
 * ──────────────────────────────────────────────────────────────────────────
 * Run this ONCE before deploying the new unique index on Lead.phone.
 *
 * Why this is needed:
 *   We just added `unique: true` on the `phone` field in Lead.model.js.
 *   If your existing MongoDB collection already contains leads with
 *   duplicate phone numbers, Mongoose/MongoDB will fail to build that
 *   index — and the app may crash or silently skip the constraint.
 *
 * What this script does:
 *   1. Connects to your MongoDB (uses the same MONGO_URI as the app).
 *   2. Groups all leads by their normalized `phone` field.
 *   3. Prints every group that has more than 1 lead, so you can decide
 *      manually which one to keep / merge / delete.
 *   4. Does NOT delete or modify anything — read-only / safe to run.
 *
 * Usage:
 *   cd backend
 *   node scripts/checkDuplicatePhones.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('../src/models/Lead.model');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB\n');

  const duplicates = await Lead.aggregate([
    {
      $group: {
        _id: '$phone',
        count: { $sum: 1 },
        leads: {
          $push: {
            id: '$_id',
            name: '$name',
            status: '$status',
            assignedTo: '$assignedTo',
            createdAt: '$createdAt',
          },
        },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  if (duplicates.length === 0) {
    console.log('🎉 No duplicate phone numbers found. Safe to deploy the unique index.');
  } else {
    console.log(`⚠️  Found ${duplicates.length} phone number(s) with duplicates:\n`);
    duplicates.forEach((dup) => {
      console.log(`📞 Phone: ${dup._id}  (${dup.count} leads)`);
      dup.leads.forEach((l) => {
        console.log(
          `   - id=${l.id}  name="${l.name}"  status=${l.status}  ` +
          `assignedTo=${l.assignedTo || 'unassigned'}  createdAt=${l.createdAt}`
        );
      });
      console.log('');
    });
    console.log(
      '👉 Please manually decide which lead to keep for each phone number above ' +
      '(e.g. keep the oldest / most progressed one), then delete the rest before ' +
      're-running the app — otherwise MongoDB will refuse to build the unique index.'
    );
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
