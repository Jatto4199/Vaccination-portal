// Regenerates the stored Vaccination Schedule (section 3.12.7) on the server.
// Called after records change and daily, because statuses such as "overdue"
// depend on the current date.

import { computeSchedule, toScheduleRows, scheduleOptions, todayISO } from '@vax/shared';
import { getSettings, nowISO } from './db.js';

const COLUMNS = ['id', 'patient_id', 'vaccine_id', 'dose_number', 'expected_due_date', 'actual_administration_date',
  'status', 'earliest_date', 'waiting_for', 'early', 'last_updated'];

// patientIds: array of ids, or null for every patient.
export async function regenerateSchedules(q, patientIds = null, today = todayISO()) {
  const vaccines = await q.query('SELECT * FROM vaccines');
  const options = { ...scheduleOptions(await getSettings(q)), today };
  const patients = patientIds
    ? await q.query('SELECT * FROM patients WHERE id = ANY($1)', [patientIds])
    : await q.query('SELECT * FROM patients');
  if (!patients.length) return 0;
  const ids = patients.map((p) => p.id);
  const records = await q.query('SELECT * FROM vaccination_records WHERE patient_id = ANY($1)', [ids]);
  const byPatient = Map.groupBy(records, (r) => r.patient_id);

  await q.query('DELETE FROM vaccination_schedules WHERE patient_id = ANY($1)', [ids]);
  const now = nowISO();
  for (const patient of patients) {
    if (patient.merged_into_id) continue;
    const rows = toScheduleRows(computeSchedule(patient, byPatient.get(patient.id) ?? [], vaccines, options), now);
    if (!rows.length) continue;
    const params = [];
    const tuples = rows.map((row) => {
      const start = params.length;
      params.push(...COLUMNS.map((c) => row[c] ?? (c === 'early' ? false : null)));
      return `(${COLUMNS.map((_, i) => `$${start + i + 1}`).join(', ')})`;
    });
    await q.query(`INSERT INTO vaccination_schedules (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`, params);
  }
  return patients.length;
}
