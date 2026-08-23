// One-off seeder. Run locally:  node scripts/seed.js
// NEVER exposed over HTTP. Refuses to run in production.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User.model');
const Account = require('../src/models/Account.model');

async function seed() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run seed in production.');
    process.exit(1);
  }

  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password || password.length < 10) {
    console.error(
      'Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (>= 10 chars) in your .env first.'
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  // --- Admin ---
  const existing = await User.findOne({ email: email.toLowerCase() });
  let adminTenantId;
  if (existing) {
    console.log(`Admin "${email}" already exists. Nothing to do.`);
    adminTenantId = existing.tenantId;
  } else {
    // Every admin needs their own Account (tenant) — this is the
    // business this admin and their future employees all belong to.
    const account = await Account.create({
      name: process.env.SEED_ACCOUNT_NAME || 'My Business',
      businessType: process.env.SEED_ACCOUNT_TYPE || '',
    });
    adminTenantId = account._id;

    await User.create({
      tenantId: adminTenantId,
      name: 'Admin',
      email: email.toLowerCase(),
      password, // hashed by pre-save hook
      role: 'admin',
      isActive: true,
    });
    console.log(`Account "${account.name}" and admin "${email}" created.`);
  }

  // --- Employee (optional, testing ke liye) ---
  const empEmail = process.env.SEED_EMP_EMAIL;
  const empPassword = process.env.SEED_EMP_PASSWORD;

  if (empEmail && empPassword) {
    const existingEmp = await User.findOne({ email: empEmail.toLowerCase() });
    if (!existingEmp) {
      // Employee always belongs to the SAME tenant as the admin who
      // "owns" them in this seed script.
      await User.create({
        tenantId: adminTenantId,
        name: 'Employee',
        email: empEmail.toLowerCase(),
        password: empPassword,
        role: 'employee',
        isActive: true,
      });
      console.log(`Employee "${empEmail}" created.`);
    } else {
      console.log(`Employee "${empEmail}" already exists.`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});