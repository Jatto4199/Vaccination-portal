// Vaccination Scheduling Engine and Reminder Module on the node
// (thesis sections 3.10 and 3.11).
//
// The schedule of each patient is calculated from the shared engine and stored
// in vaccination_schedules. It is regenerated when a patient or vaccination
// record changes (locally or through sync) and once a day, because a dose
// becomes "due today" or "overdue" with the passing of time. Each time a
// dose becomes upcoming, due or overdue, a notification is created for the
// health workers on this node.

import { computeSchedule, toScheduleRows, scheduleOptions, todayISO, ACTIONABLE, STATUS_LABELS, describeAge } from '../shared/index.js';
import { db, getMeta, setMeta } from './db.js';
import { getSettings } from './config.js';

const MESSAGES = {
  upcoming: (p, v, row) => `${p.full_name} is due for ${v} on ${row.expected_due_date}.`,
  due: (p, v) => `${p.full_name} is due for ${v} today.`,
  overdue: (p, v, row) => `${p.full_name} has missed ${v} (due ${row.expected_due_date}).`,
};

// patientIds: array of ids, or null for every patient on this node.
export async function refreshSchedules(patientIds = null) {
  const today = todayISO();
  const options = { ...scheduleOptions(getSettings()), today };
  const vaccines = await db.vaccines.toArray();
  if (!vaccines.length) return;
  const patients = patientIds
    ? (await db.patients.bulkGet([...new Set(patientIds)])).filter(Boolean)
    : await db.patients.toArray();
  const ids = patients.map((p) => p.id);
  const records = await db.vaccination_records.where('patient_id').anyOf(ids).toArray();
  const byPatient = Map.groupBy(records, (r) => r.patient_id);
  const vaccineNames = new Map(vaccines.map((v) => [v.id, `${v.name} dose ${v.dose_number}`]));
  const now = new Date().toISOString();

  await db.transaction('rw', db.vaccination_schedules, db.notifications, async () => {
    await db.vaccination_schedules.where('patient_id').anyOf(ids).delete();
    for (const patient of patients) {
      if (patient.merged_into_id) continue;
      const rows = toScheduleRows(computeSchedule(patient, byPatient.get(patient.id) ?? [], vaccines, options), now);
      await db.vaccination_schedules.bulkPut(rows);
      for (const row of rows) {
        if (ACTIONABLE.includes(row.status)) {
          const id = `${row.id}:${row.status}`;
          if (!(await db.notifications.get(id))) {
            await db.notifications.add({
              id, schedule_id: row.id, patient_id: patient.id, type: row.status, title: STATUS_LABELS[row.status],
              message: MESSAGES[row.status](patient, vaccineNames.get(row.vaccine_id), row),
              detail: patient.dob ? `Age ${describeAge(patient.dob, today)}` : null, created_at: now, read: 0,
            });
          }
        } else if (row.status === 'completed') {
          // Unread reminders for a dose that has now been given are no longer needed.
          await db.notifications.where('schedule_id').equals(row.id).filter((n) => !n.read).delete();
        }
      }
    }
  });
  if (!patientIds) await setMeta('schedulesRefreshedOn', today);
}

// Re-evaluates all schedules once per day (status depends on today's date).
export async function refreshIfNewDay() {
  if ((await getMeta('schedulesRefreshedOn')) !== todayISO()) await refreshSchedules();
}
