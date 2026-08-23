/**
 * Migration: Backfill status='Deleted' on leads that were soft-deleted
 * before this status existed.
 *
 * Previously, soft-deleting a lead set isDeleted=true but left `status`
 * unchanged (e.g. still "Interested"), which meant deleted leads kept
 * counting toward active stats/lists. Going forward, softDeleteLead sets
 * status='Deleted' directly. This script fixes up old records so they
 * match: for every lead with isDeleted=true and status !== 'Deleted',
 * save the current status into statusBeforeDelete (if not already set)
 * and set status='Deleted'.
 *
 * Run once: node scripts/migrateDeletedStatus.js
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

  const staleDeleted = await Lead.find({
    isDeleted: true,
    status: { $ne: 'Deleted' },
  }).toArray();

  console.log(`Found ${staleDeleted.length} soft-deleted lead(s) with a stale status`);

  let updated = 0;
  for (const lead of staleDeleted) {
    await Lead.updateOne(
      { _id: lead._id },
      {
        $set: {
          statusBeforeDelete: lead.statusBeforeDelete || lead.status,
          status: 'Deleted',
        },
      }
    );
    updated++;
  }

  console.log(`✅  Migration complete: ${updated} lead(s) updated`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
});