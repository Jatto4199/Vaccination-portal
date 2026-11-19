const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return fmtDate(iso);
}

export function timeUntil(iso) {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((new Date(iso) - Date.now()) / 1000));
  return secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`;
}

export function vaccineName(vaccines, id) {
  return vaccines.get(id)?.name ?? id;
}

export function vaccineLabel(vaccines, id) {
  const v = vaccines.get(id);
  return v ? `${v.name} dose ${v.dose_number}` : id;
}

export const isValidPhone = (phone) => /^\+?\d{7,15}$/.test(phone.replace(/[\s-]/g, ''));
export const cleanPhone = (phone) => phone.replace(/[\s-]/g, '');

// Downloads rows (arrays of values, first row = headings) as a CSV file that
// opens in Excel or Google Sheets.
export function downloadCsv(filename, rows) {
  const cell = (v) => {
    const text = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
