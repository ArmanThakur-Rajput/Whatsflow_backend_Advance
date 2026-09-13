/**
 * fix-sept.js
 * 
 * Ek baar run karo — sirf September 2025 ke leads mein
 * "Sept" ko "Sep" se replace karta hai.
 * 
 * Usage:
 *   MONGO_URI="your_mongo_uri" node fix-sept.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI env variable set nahi hai!');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB connected');

  const db = mongoose.connection.db;
  const collection = db.collection('leads');

  // Pehle dekho kitne records affected hain
  const affected = await collection.countDocuments({
    visitorDate: /Sept/,
  });
  console.log(`🔍 "Sept" wale leads mila: ${affected}`);

  if (affected === 0) {
    console.log('✅ Kuch fix karne ki zarurat nahi — sab theek hai!');
    await mongoose.disconnect();
    return;
  }

  // Preview karo — kaun se leads fix honge
  const preview = await collection
    .find({ visitorDate: /Sept/ }, { projection: { name: 1, visitorDate: 1 } })
    .toArray();

  console.log('\n📋 In leads ka visitorDate fix hoga:');
  preview.forEach(l =>
    console.log(`   → ${l.name} | "${l.visitorDate}" → "${l.visitorDate.replace('Sept', 'Sep')}"`)
  );

  // Fix karo
  const result = await collection.updateMany(
    { visitorDate: /Sept/ },
    [{ $set: { visitorDate: { $replaceAll: { input: '$visitorDate', find: 'Sept', replacement: 'Sep' } } } }]
  );

  console.log(`\n✅ Fix complete! ${result.modifiedCount} leads update hue.`);
  await mongoose.disconnect();
  console.log('🔌 Disconnected.');
}

run().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
