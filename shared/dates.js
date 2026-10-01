// Date helpers. All clinical dates are plain ISO strings ("YYYY-MM-DD") and
// arithmetic is done in UTC so results never shift with the device timezone.

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatISO(date) {
  return date.toISOString().slice(0, 10);
}

// Today's date in the device's local timezone (the clinic's calendar day).
export function todayISO(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return formatISO(d);
}

// Adds calendar months, clamping to the last day of the month
// (e.g. 31 Jan + 1 month = 28/29 Feb).
export function addMonths(iso, n) {
  const d = parseISO(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return formatISO(d);
}

// Periods are written as a number and a unit: "0d", "6w", "9m", "1y".
export function addPeriod(iso, period) {
  const match = /^(\d+)([dwmy])$/.exec(period);
  if (!match) throw new Error(`Invalid period "${period}"`);
  const n = Number(match[1]);
  switch (match[2]) {
    case 'd': return addDays(iso, n);
    case 'w': return addDays(iso, n * 7);
    case 'm': return addMonths(iso, n);
    case 'y': return addMonths(iso, n * 12);
  }
}

// Whole days from `a` to `b` (positive when b is later).
export function diffDays(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

export function maxISO(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function describeAge(dob, today = todayISO()) {
  const days = diffDays(dob, today);
  if (days < 0) return 'not yet born';
  if (days < 7 * 8) return `${Math.floor(days / 7)} wk${days >= 14 ? 's' : ''}`;
  let months = 0;
  while (addMonths(dob, months + 1) <= today) months++;
  if (months < 24) return `${months} mo`;
  return `${Math.floor(months / 12)} yrs`;
}
