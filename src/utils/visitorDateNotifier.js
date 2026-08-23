/**
 * visitorDateNotifier.js
 *
 * Do alag cron jobs chalate hain:
 *
 *  1. EVE NOTIFICATION  — har raat 8 PM IST (14:30 UTC)
 *     Kal jis lead ka visitorDate hai unhe ek din pehle remind karta hai.
 *
 *  2. DAY-OF SCHEDULER — har subah 6 AM IST (00:30 UTC)
 *     Aaj ke saare visitors fetch karta hai.
 *     Jo lead ka visitorTime set hai, usse 2 ghante pehle setTimeout se
 *     notification schedule karta hai.
 *     Jo lead ka visitorTime nahi hai, usse skip karta hai
 *     (eve notification already chal chuki hogi).
 *
 * Har notification mein:
 *   - Title : lead ka naam
 *   - Body  : lead ka phone number + context
 *   - data  : { leadId } — frontend ise click pe lead screen open karne ke liye use kare
 *
 * Notification kise bhejte hain:
 *   - Lead ka assignedTo employee (agar set hai)
 *   - Us tenant ke saare active admins
 *   (duplicates automatically skip hote hain agar admin aur employee ek hi ho)
 */

const cron = require('node-cron');
const Lead = require('../models/Lead.model');
const User = require('../models/User.model');
const Notification = require('../models/Notification.model');
const sendPushNotification = require('./sendPushNotification');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Lead model mein visitorDate "DD MMM YYYY" (e.g. "21 Aug 2026") format mein
 * stored hai. Ise parse karke ek Date object return karta hai, ya null agar
 * format galat ho.
 */
function parseVisitorDate(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [day, mon, year] = parts;
  const monthIdx = MONTHS[mon];
  if (monthIdx === undefined) return null;
  const d = new Date(+year, monthIdx, +day);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * Aaj ki date "DD MMM YYYY" format mein return karta hai (IST).
 * FIX: toLocaleDateString() ki jagah manual construction use kiya
 * taaki Node version se "Aug." vs "Aug" mismatch na ho.
 */
function todayFormatted() {
  const now = new Date();
  // IST = UTC + 5:30
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const ist = new Date(istMs);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mmm = MONTH_NAMES[ist.getUTCMonth()];
  const yyyy = ist.getUTCFullYear();
  return `${dd} ${mmm} ${yyyy}`;
}

/**
 * N din baad ki date "DD MMM YYYY" format mein return karta hai (IST).
 */
function daysFromNowFormatted(n) {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const ist = new Date(istMs + n * 24 * 60 * 60 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mmm = MONTH_NAMES[ist.getUTCMonth()];
  const yyyy = ist.getUTCFullYear();
  return `${dd} ${mmm} ${yyyy}`;
}

/**
 * visitorTime "10:30 AM" / "10:30 PM" format se aaj ka UTC Date object banata hai.
 * FIX: pure UTC math use kiya — toLocaleString() wala unreliable approach hata diya.
 */
function parseVisitorTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;

  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3].toUpperCase();

  if (meridiem === 'PM' && hours !== 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;

  // IST = UTC + 5:30
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const now = new Date();

  // Aaj ki IST date ke UTC components
  const istNow = new Date(now.getTime() + istOffsetMs);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();

  // IST visitor time → UTC
  const visitUTC = new Date(Date.UTC(y, m, d, hours, minutes, 0) - istOffsetMs);

  if (isNaN(visitUTC.getTime())) return null;
  return visitUTC;
}

// ─── Core: recipients collect + notification bhejo ───────────────────────────

async function dispatchNotification(lead, title, body) {
  const admins = await User.find({
    tenantId: lead.tenantId,
    role: 'admin',
    isActive: true,
  }).select('_id pushTokens').lean();

  const recipientMap = new Map();
  for (const admin of admins) {
    recipientMap.set(String(admin._id), admin);
  }

  if (lead.assignedTo) {
    const emp = await User.findOne({
      _id: lead.assignedTo,
      tenantId: lead.tenantId,
      isActive: true,
    }).select('_id pushTokens').lean();
    if (emp) recipientMap.set(String(emp._id), emp);
  }

  if (!recipientMap.size) {
    console.log(`[VisitorNotifier] No recipients found for lead "${lead.name}" — skip`);
    return;
  }

  const pushData = {
    leadId: String(lead._id),
    type: 'visitor_date_reminder',
  };

  const notifDocs = [...recipientMap.values()].map((u) => ({
    tenantId: lead.tenantId,
    user: u._id,
    title,
    message: body,
    type: 'alert',
    broadcast: false,
  }));

  await Notification.insertMany(notifDocs);

  await Promise.allSettled(
    [...recipientMap.values()]
      .filter((u) => u.pushTokens?.length)
      .map((u) => u.pushTokens.map((t) => sendPushNotification(t, title, body, pushData)))
      .flat()
  );

  console.log(
    `[VisitorNotifier] Sent "${title}" for lead "${lead.name}" (${lead._id}) ` +
    `to ${recipientMap.size} recipient(s)`
  );
}

// ─── 1. Eve notification — 1 din pehle raat 8 PM IST ───────────────────────

async function sendEveNotifications() {
  const tomorrow = daysFromNowFormatted(1);
  console.log(`[VisitorNotifier] Eve cron running for ${tomorrow}`);

  const leads = await Lead.find({
    visitorDate: tomorrow,
    isDeleted: false,
  }).select('_id name phone tenantId assignedTo visitorDate visitorTime').lean();

  if (!leads.length) {
    console.log(`[VisitorNotifier] No leads for tomorrow (${tomorrow})`);
    return;
  }

  for (const lead of leads) {
    try {
      const timeLabel = lead.visitorTime ? ` at ${lead.visitorTime}` : '';
      const title = `🔔 Visitor Tomorrow: ${lead.name}`;
      const body = `${lead.name} (${lead.phone}) is scheduled to visit tomorrow${timeLabel}.`;
      await dispatchNotification(lead, title, body);
    } catch (err) {
      console.error(`[VisitorNotifier] Eve error for lead ${lead._id}:`, err.message);
    }
  }
}

// ─── 2. Day-of scheduler — subah 6 AM IST pe chalta hai ─────────────────────

async function scheduleDayOfNotifications() {
  const today = todayFormatted();
  console.log(`[VisitorNotifier] Day-of scheduler running — today = "${today}"`);

  const leads = await Lead.find({
    visitorDate: today,
    isDeleted: false,
    visitorTime: { $nin: ['', null] },
  }).select('_id name phone tenantId assignedTo visitorDate visitorTime').lean();

  console.log(`[VisitorNotifier] Leads found with visitorTime today: ${leads.length}`);
  leads.forEach(l =>
    console.log(`  → "${l.name}" | visitorDate: "${l.visitorDate}" | visitorTime: "${l.visitorTime}"`)
  );

  if (!leads.length) return;

  const now = Date.now();

  for (const lead of leads) {
    try {
      const visitTime = parseVisitorTime(lead.visitorTime);
      if (!visitTime) {
        console.log(`[VisitorNotifier] Could not parse visitorTime "${lead.visitorTime}" for lead ${lead._id} — skip`);
        continue;
      }

      // 2 ghante pehle
      const notifyAt = visitTime.getTime() - (2 * 60 * 60 * 1000);
      const delay = notifyAt - now;

      const notifyAtIST = new Date(notifyAt).toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
      });

      if (delay <= 0) {
        console.log(`[VisitorNotifier] 2hr window already passed for "${lead.name}" (was ${notifyAtIST} IST) — skip`);
        continue;
      }

      console.log(
        `[VisitorNotifier] Scheduling day-of notif for "${lead.name}" ` +
        `at ${notifyAtIST} IST (in ${Math.round(delay / 60000)} min)`
      );

      setTimeout(async () => {
        try {
          console.log(`[VisitorNotifier] Firing day-of notif for "${lead.name}"`);
          const title = `🗓️ Visitor in 2 Hours: ${lead.name}`;
          const body = `${lead.name} (${lead.phone}) is visiting at ${lead.visitorTime} today.`;
          await dispatchNotification(lead, title, body);
        } catch (err) {
          console.error(`[VisitorNotifier] Day-of dispatch error for lead ${lead._id}:`, err.message);
        }
      }, delay);

    } catch (err) {
      console.error(`[VisitorNotifier] Day-of schedule error for lead ${lead._id}:`, err.message);
    }
  }
}

// ─── Cron registration ───────────────────────────────────────────────────────

function startVisitorDateNotifier() {
  // ── 1. EVE NOTIFICATION — raat 8 PM IST = 14:30 UTC ─────────────────────
  cron.schedule('30 14 * * *', async () => {
    await sendEveNotifications();
  }, { timezone: 'UTC' });

  // ── 2. DAY-OF SCHEDULER — subah 6 AM IST = 00:30 UTC ────────────────────
  cron.schedule('30 0 * * *', async () => {
    await scheduleDayOfNotifications();
  }, { timezone: 'UTC' });

  console.log('[VisitorNotifier] Eve (8 PM IST) & Day-of scheduler (6 AM IST) crons registered');
}

module.exports = { startVisitorDateNotifier, scheduleDayOfNotifications, sendEveNotifications };
