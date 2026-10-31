/**
 * visitStatus.js
 *
 * Shared helpers for the visitor lifecycle:
 *
 *   upcoming ──(visit time passes)──► awaiting update  (derived, not stored)
 *      │                                   │
 *      │            ┌──────────────────────┼───────────────────────┐
 *      ▼            ▼                      ▼                       ▼
 *  reschedule   completed (+details)   reschedule (date+time)   cancelled (+reason)
 *  (back to upcoming)
 *
 * All date/time strings in the DB are IST wall-clock:
 *   visitorDate "DD MMM YYYY"  (e.g. "21 Aug 2026")
 *   visitorTime "hh:mm AM/PM"  (e.g. "10:30 AM"), optional
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Visit with no time set is treated as ending at 6 PM IST that day.
const DEFAULT_VISIT_HOUR_IST = 18;

// How long after the visit time we wait before asking "did it happen?"
// (so we don't ping while the customer is still there).
const PROMPT_DELAY_MIN = 30;

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Normalises client date strings: "13-Sep-2026" / "13 Sept 2026" → "13 Sep 2026". */
function normalizeVisitorDate(input) {
  if (typeof input !== 'string') return '';
  let s = input.trim();
  s = s.replace(
    /(\d{1,2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)-(\d{4})/i,
    (_, d, m, y) => `${d.padStart(2, '0')} ${m} ${y}`
  );
  s = s.replace(/Sept/i, 'Sep');
  return s;
}

/** "DD MMM YYYY" → { y, m, d } or null */
function parseDateParts(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const m = MONTHS[parts[1]];
  const d = parseInt(parts[0], 10);
  const y = parseInt(parts[2], 10);
  if (m === undefined || !d || !y) return null;
  return { y, m, d };
}

/** "10:30 AM" → { h, min } (24h) or null */
function parseTimeParts(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const min = parseInt(match[2], 10);
  const mer = match[3].toUpperCase();
  if (h < 1 || h > 12 || min > 59) return null;
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return { h, min };
}

/**
 * The instant (UTC Date) at which this lead's visit is scheduled.
 * No time set → DEFAULT_VISIT_HOUR_IST. Returns null if date is unparseable.
 */
function visitAtUTC(visitorDate, visitorTime) {
  const dp = parseDateParts(visitorDate);
  if (!dp) return null;
  const tp = parseTimeParts(visitorTime) || { h: DEFAULT_VISIT_HOUR_IST, min: 0 };
  return new Date(Date.UTC(dp.y, dp.m, dp.d, tp.h, tp.min, 0) - IST_OFFSET_MS);
}

/** "DD MMM YYYY" for (today + offsetDays) in IST. */
function istDateString(offsetDays = 0) {
  const ist = new Date(Date.now() + IST_OFFSET_MS + offsetDays * 86400000);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  return `${dd} ${MONTH_NAMES[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

/**
 * Derived state used by the UI:
 *   'completed' | 'cancelled' | 'awaiting' | 'upcoming'
 * Leads without visitStatus (created before this feature) count as upcoming.
 */
function deriveVisitState(lead, nowMs = Date.now()) {
  const stored = lead.visitStatus || 'upcoming';
  if (stored === 'completed' || stored === 'cancelled') return stored;
  const at = visitAtUTC(lead.visitorDate, lead.visitorTime);
  if (at && at.getTime() <= nowMs) return 'awaiting';
  return 'upcoming';
}

module.exports = {
  IST_OFFSET_MS,
  DEFAULT_VISIT_HOUR_IST,
  PROMPT_DELAY_MIN,
  normalizeVisitorDate,
  parseDateParts,
  parseTimeParts,
  visitAtUTC,
  istDateString,
  deriveVisitState,
};
