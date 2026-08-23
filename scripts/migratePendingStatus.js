/**
 * Migration: Fix status='pending' (lowercase) → status='Pending' (Title Case)
 *
 * Older records in the DB may have status stored as lowercase 'pending'
 * due to a consistency bug. The Lead model enum uses 'Pending' (Title Case),
 * so any lowercase records fail enum validation and don't show up in filters.
 *
 * Run once: node scripts/migratePendingStatus.js
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

  const stale = await Lead.countDocuments({ status: 'pending' });
  console.log(`Found ${stale} lead(s) with status='pending' (lowercase)`);

  if (stale === 0) {
    console.log('✅  Nothing to migrate');
    await mongoose.disconnect();
    return;
  }

  const result = await Lead.updateMany(
    { status: 'pending' },
    { $set: { status: 'Pending' } }
  );

  console.log(`✅  Migration complete: ${result.modifiedCount} lead(s) updated to 'Pending'`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
});