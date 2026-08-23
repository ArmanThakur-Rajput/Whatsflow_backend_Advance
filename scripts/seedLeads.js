require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('../src/models/Lead.model');
const Account = require('../src/models/Account.model');
const User = require('../src/models/User.model');
const { startOfDaysAgo } = require('../src/utils/dateRange');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/leads';

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[randInt(0, arr.length - 1)];

const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Ayaan',
  'Atharva', 'Krishna', 'Ishaan', 'Ananya', 'Pari', 'Aanya', 'Riya',
  'Saanvi', 'Priya', 'Nisha', 'Pooja', 'Sneha', 'Kavya', 'Rahul',
  'Rohit', 'Amit', 'Suresh', 'Vijay',
];
const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Singh', 'Kumar', 'Patel', 'Shah',
  'Mehta', 'Joshi', 'Mishra', 'Yadav', 'Agarwal', 'Tiwari', 'Pandey',
];
const CITIES = ['Mumbai', 'Pune', 'Delhi', 'Bangalore', 'Hyderabad', 'Nagpur', 'Nashik'];
const SOURCES = ['Facebook', 'Instagram', 'Google', 'JustDial', 'CarDekho', 'Manual', 'Reference'];
const CARS = [
  'Maruti Swift', 'Maruti Baleno', 'Hyundai i20', 'Hyundai Creta',
  'Tata Nexon', 'Tata Punch', 'Honda City', 'Kia Seltos', 'Mahindra Thar',
];

// Current valid statuses (must match Lead.model.js enum)
const STATUSES = ['New', 'Interested', 'Contacted', 'Not Interested', 'Pending', 'Booked'];

const usedPhones = new Set();

async function uniquePhone() {
  const prefixes = ['98', '97', '96', '95', '94', '93', '92', '91', '90', '89'];
  let phone;
  let exists = true;
  while (exists) {
    const prefix = pick(prefixes);
    const suffix = String(randInt(10000000, 99999999));
    phone = prefix + suffix;
    if (usedPhones.has(phone)) continue;
    exists = await Lead.exists({ $or: [{ phone }, { secondaryPhone: phone }] });
  }
  usedPhones.add(phone);
  return phone;
}

// Distribution: 10 today, 4 yesterday, 6 this week (2-6 days), 3 older (7-20 days)
function buildDatePlan() {
  const plan = [];
  for (let i = 0; i < 10; i++) plan.push(0);
  for (let i = 0; i < 4; i++) plan.push(1);
  for (let i = 0; i < 6; i++) plan.push(randInt(2, 6));
  for (let i = 0; i < 3; i++) plan.push(randInt(7, 20));
  return plan; // 23 leads total
}

async function buildLead(daysBack, employees, forceStatus,tenantId) {
  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const name = `${firstName} ${lastName}`;

  const createdAt = new Date(
    startOfDaysAgo(daysBack).getTime() + randInt(8, 19) * 60 * 60 * 1000 // some hour in the day
  );

  const status = forceStatus || pick(STATUSES);

  // Booked leads: updatedAt should be on/after createdAt (today for "booked today" testing on day-0 leads)
  const updatedAt = status === 'Booked'
    ? new Date(createdAt.getTime() + randInt(0, 4) * 60 * 60 * 1000)
    : new Date(createdAt.getTime() + randInt(0, 2) * 60 * 60 * 1000);

  const employee = employees.length ? pick(employees) : null;
  const phone = await uniquePhone();

  return {
    tenantId,
    name,
    phone,
    secondaryPhone: '',
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randInt(1, 99)}@gmail.com`,
    city: pick(CITIES),
    source: pick(SOURCES),
    car: pick(CARS),
    status,
    isPinned: false,
    assignedTo: employee?._id || null,
    notes: [],
    timeline: [{
      type: 'created',
      description: 'Lead created via seedTestLeads script',
      createdAt,
      updatedAt: createdAt,
    }],
    createdAt,
    updatedAt,
  };
}

async function seed() {
  await mongoose.connect(MONGO_URI);
  const account = await Account.findOne();

  if (!account) {
  throw new Error('No Account found');
   }

  console.log('🏢 Using Account:', account._id);
  console.log('✅  Connected to MongoDB:', MONGO_URI);


  const targetEmail = process.argv[2];
  let employees;
  if (targetEmail) {
    const emp = await User.findOne({ email: targetEmail, role: 'employee' }).select('_id name');
    if (!emp) {
      console.error(`❌  No employee found with email: ${targetEmail}`);
      process.exit(1);
    }
    employees = [emp];
    console.log(`👤  Assigning all test leads to: ${emp.name} (${targetEmail})`);
  } else {
    employees = await User.find({ role: 'employee', isActive: true }).select('_id name');
    if (!employees.length) {
      console.warn('⚠️  No active employees found — leads will be unassigned.');
    } else {
      console.log(`👥  Found ${employees.length} employee(s): ${employees.map(e => e.name).join(', ')}`);
    
    }
  }

  const datePlan = buildDatePlan();
  const leads = [];
  for (const daysBack of datePlan) {
    leads.push(await buildLead(daysBack, employees, null, account._id));
  }

  // Add 2 already-deleted leads (today) so the archive screen has
  // something to show under the "Deleted" filter during testing.
  for (let i = 0; i < 2; i++) {
    const lead = await buildLead(
      0,
      employees,
      'Interested',
      account._id
    );
    lead.statusBeforeDelete = lead.status;
    lead.status = 'Deleted';
    lead.isDeleted = true;
    lead.deletedAt = new Date();
    lead.deletedBy = lead.assignedTo;
    leads.push(lead);
  }

  await Lead.insertMany(leads, { timestamps: false });
  console.log(`🌱  Inserted ${leads.length} test leads (existing leads untouched)`);

  const summary = {};
  for (const l of leads) summary[l.status] = (summary[l.status] || 0) + 1;
  console.log('📊  Status breakdown:', summary);

  const todayCount = leads.filter(l => l.createdAt >= startOfDaysAgo(0)).length;
  console.log(`📅  Created today: ${todayCount}`);

  await mongoose.disconnect();
  console.log('🔌  Disconnected. Done!');
}

seed().catch((err) => {
  console.error('❌  Seed failed:', err);
  process.exit(1);
});