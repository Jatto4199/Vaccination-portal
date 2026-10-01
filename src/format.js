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
