const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

// Returns the YYYY-MM-DD string for `date` in the app timezone.
function todayString(date = new Date()) {
  // en-CA formats as ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// How many minutes APP_TZ is ahead of UTC at the given instant.
function tzOffsetMinutes(instant) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // Hour can come back as "24" at midnight in some environments.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asIfUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +hour,
    +parts.minute,
    +parts.second
  );
  return Math.round((asIfUTC - instant.getTime()) / 60000);
}

// UTC Date corresponding to local midnight (start of day) in APP_TZ.
function startOfDay(date = new Date()) {
  const ymd = todayString(date);
  const asUTC = new Date(`${ymd}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(asUTC);
  return new Date(asUTC.getTime() - offsetMin * 60 * 1000);
}

// UTC Date corresponding to the last millisecond of the local day in APP_TZ.
function endOfDay(date = new Date()) {
  const start = startOfDay(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

// Start of the local day that is N days before today.
function startOfDaysAgo(n, date = new Date()) {
  const start = startOfDay(date);
  return new Date(start.getTime() - n * 24 * 60 * 60 * 1000);
}

// UTC Date corresponding to local midnight on the 1st of the current
// month in APP_TZ. Used for "this month's performance" stats.
function startOfMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ,
    year: 'numeric',
    month: '2-digit',
  }).format(date);
  const [year, month] = parts.split('-');
  const asUTC = new Date(`${year}-${month}-01T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(asUTC);
  return new Date(asUTC.getTime() - offsetMin * 60 * 1000);
}

module.exports = { APP_TZ, todayString, startOfDay, endOfDay, startOfDaysAgo, startOfMonth };