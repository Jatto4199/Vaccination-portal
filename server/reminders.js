// SMS reminders for guardians (thesis section 3.11).
//
// Runs on the server, which holds the synchronized records of every clinic.
// The stored schedules are refreshed first, then each outstanding dose gets at
// most three messages:
//   upcoming  up to `reminder_days_before` days before the due date
//   due       on the due date
//   overdue   `reminder_days_overdue` or more days after the due date
// The UNIQUE constraint on notifications guarantees each is sent only once.
// Messages go only to guardians and mothers who agreed to receive SMS.
//
// Limitation: a dose given offline is unknown to the server until that clinic
// syncs, so overdue messages ask the guardian to visit rather than stating
// that a dose was missed.

import { randomUUID } from 'node:crypto';
import { diffDays, todayISO } from '../shared/index.js';
import { getSettings, nowISO } from './db.js';
import { regenerateSchedules } from './schedules.js';

// Replace with a real gateway (e.g. Africa's Talking, Termii) in deployment.
export const simulatedSender = {
  channel: 'sms',
  async send(phone, message) {
    console.log(`[SMS simulated] to ${phone}: ${message}`);
    return { status: 'sent_simulated' };
  },
};

function reminderType(row, today, settings) {
  const days = diffDays(today, row.expected_due_date);
  if (row.status === 'due') return 'due';
  if (row.status === 'upcoming' && days <= settings.reminder_days_before) return 'upcoming';
  if (row.status === 'overdue' && -days >= settings.reminder_days_overdue) return 'overdue';
  return null;
}

function messageFor(type, { contactName, patientName, isSelf, vaccineName, due, clinicName }) {
  const greeting = `Hello ${contactName},`;
  const subject = isSelf ? 'you are' : `${patientName} is`;
  const owner = isSelf ? 'your' : `${patientName}'s`;
  if (type === 'upcoming') return `${greeting} ${subject} due for ${vaccineName} on ${due} at ${clinicName}. Please remember to attend.`;
  if (type === 'due') return `${greeting} ${subject} due for ${vaccineName} today at ${clinicName}.`;
  return `${greeting} ${owner} ${vaccineName} vaccination is pending. Please visit ${clinicName} as soon as possible.`;
}

export async function runReminders(db, { sender = simulatedSender, today = todayISO() } = {}) {
  const settings = await getSettings(db);
  await db.tx((q) => regenerateSchedules(q, null, today));
  if (!settings.sms_enabled) return { sent: 0, disabled: true };

  // Every patient is reached through their guardian record; a mother's
  // guardian record is her own contact profile (guardian.patient_id = her id).
  const rows = await db.query(`SELECT s.*, p.full_name AS patient_name,
      g.id AS guardian_id, g.patient_id AS guardian_patient_id, g.full_name AS guardian_name, g.phone AS guardian_phone, g.sms_consent,
      g.preferred_notification, v.name AS vaccine_name, c.name AS clinic_name
    FROM vaccination_schedules s
    JOIN patients p ON p.id = s.patient_id
    JOIN vaccines v ON v.id = s.vaccine_id
    JOIN guardians g ON g.id = p.guardian_id
    LEFT JOIN clinics c ON c.id = p.clinic_id
    WHERE s.status IN ('upcoming', 'due', 'overdue') AND p.merged_into_id IS NULL`);

  let sent = 0;
  for (const row of rows) {
    if (!row.guardian_phone || !row.sms_consent || row.preferred_notification === 'none') continue;
    const contact = { name: row.guardian_name, phone: row.guardian_phone };
    const type = reminderType(row, today, settings);
    if (!type) continue;
    const exists = await db.one(`SELECT 1 FROM notifications WHERE patient_id = $1 AND vaccine_id = $2 AND type = $3
      AND status != 'failed'`, [row.patient_id, row.vaccine_id, type]);
    if (exists) continue;

    const message = messageFor(type, {
      contactName: contact.name, patientName: row.patient_name, isSelf: row.guardian_patient_id === row.patient_id,
      vaccineName: `${row.vaccine_name} (dose ${row.dose_number})`, due: row.expected_due_date, clinicName: row.clinic_name ?? 'your clinic',
    });
    let result;
    try {
      result = await sender.send(contact.phone, message);
    } catch (err) {
      result = { status: 'failed', error: err.message };
    }
    // Failed messages are replaced (and so retried) on the next run.
    await db.query(`INSERT INTO notifications (id, patient_id, guardian_id, vaccine_id, type, channel, phone, message, status,
      error, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (patient_id, vaccine_id, type) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error,
      created_at = EXCLUDED.created_at`,
    [randomUUID(), row.patient_id, row.guardian_id, row.vaccine_id, type, sender.channel, contact.phone, message,
      result.status, result.error ?? null, nowISO()]);
    if (result.status !== 'failed') sent++;
  }
  return { sent };
}
