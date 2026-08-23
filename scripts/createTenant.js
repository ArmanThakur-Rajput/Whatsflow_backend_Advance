/**
 * Onboard a brand-new tenant (business) with its first admin account.
 *
 * Since this app's signup is intentionally NOT self-serve (confirmed:
 * no public registration endpoint), this script is how a new business
 * — a tour-and-travel company, a bank branch, anyone — gets set up.
 * Run once per new business:
 *
 *   node scripts/createTenant.js \
 *     --name "Sunrise Tours & Travels" \
 *     --type "Travel Agency" \
 *     --adminEmail owner@sunrisetours.com \
 *     --adminPassword "SomeStrongPassword123" \
 *     --adminName "Raj Sharma"
 *
 * NEVER exposed over HTTP — command line only, same as scripts/seed.js.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Account = require('../src/models/Account.model');
const User = require('../src/models/User.model');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

async function createTenant() {
  const { name, type, adminEmail, adminPassword, adminName } = parseArgs();

  if (!name || !adminEmail || !adminPassword) {
    console.error(
      'Usage: node scripts/createTenant.js --name "Business Name" --adminEmail you@example.com --adminPassword "..." [--type "Travel Agency"] [--adminName "Full Name"]'
    );
    process.exit(1);
  }
  if (adminPassword.length < 10) {
    console.error('--adminPassword must be at least 10 characters.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const existingEmail = await User.findOne({ email: adminEmail.toLowerCase() });
  if (existingEmail) {
    console.error(`A user with email "${adminEmail}" already exists. Choose a different email.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const account = await Account.create({
    name: name.trim(),
    businessType: (type || '').trim(),
  });

  const admin = await User.create({
    tenantId: account._id,
    name: (adminName || 'Admin').trim(),
    email: adminEmail.toLowerCase(),
    password: adminPassword, // hashed by the User model's pre-save hook
    role: 'admin',
    isActive: true,
  });

  console.log('✅ Tenant created successfully:');
  console.log(`   Account:  ${account.name} (${account._id})`);
  console.log(`   Admin:    ${admin.email} (${admin._id})`);
  console.log('   They can now log in with the email/password above.');

  await mongoose.disconnect();
  process.exit(0);
}

createTenant().catch((err) => {
  console.error(err);
  process.exit(1);
});
