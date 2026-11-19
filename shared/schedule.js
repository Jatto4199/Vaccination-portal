// Vaccination scheduling engine (thesis section 3.10).
//
// Inputs: the patient's date of birth (or registration date for maternal
// doses), the configured vaccines, and the vaccination records so far.
//
//   Expected due date = Date of birth + recommended age            (first dose)
//   Expected due date = max(DOB + recommended age,
//                           previous dose + recommended interval)  (later doses)
//
// A later dose is only scheduled once the previous dose of the same vaccine has
// been given, so a child who presents late gets a catch-up schedule built from
// the doses actually received. A dose is "not eligible" once the child is past
// its maximum age, and it then does not block later doses.
//
// The result is stored in the Vaccination Schedule table on every node and is
// regenerated whenever a record changes and once a day (status depends on today).

import { addPeriod, addDays, diffDays, maxISO, todayISO } from './dates.js';

export const STATUS = {
  COMPLETED: 'completed',
  OVERDUE: 'overdue',
  DUE: 'due',
  UPCOMING: 'upcoming',
  SCHEDULED: 'scheduled',
  WAITING: 'waiting',
  NOT_ELIGIBLE: 'not_eligible',
  INACTIVE: 'inactive',
};

export const STATUS_LABELS = {
  completed: 'Completed',
  overdue: 'Overdue',
  due: 'Due today',
  upcoming: 'Upcoming',
  scheduled: 'Scheduled',
  waiting: 'Waiting for previous dose',
  not_eligible: 'Not eligible (age limit passed)',
  inactive: 'Not followed up (patient inactive)',
};

// Patient status. Anything other than "active" stops follow-up: outstanding
// doses get the "inactive" status, so they leave the due/overdue lists and no
// reminders are sent. A missing status (older records) means active.
export const PATIENT_STATUSES = {
  active: 'Active',
  moved_away: 'Moved away',
  lost_to_follow_up: 'Lost to follow-up',
  deceased: 'Deceased',
};

export const isActivePatient = (patient) => !patient.status || patient.status === 'active';

// Statuses that need follow-up by the clinic.
export const ACTIONABLE = [STATUS.OVERDUE, STATUS.DUE, STATUS.UPCOMING];

export const doseLabel = (code, dose) => `${code} ${dose}`;

export const isValidRecord = (record) => record.record_status !== 'voided';

export function computeSchedule(patient, records, vaccines, options = {}) {
  const today = options.today ?? todayISO();
  const upcomingDays = options.upcomingDays ?? 7;
  const graceDays = options.graceDays ?? 0;
  const dob = patient.dob || null;

  const given = records
    .filter((r) => r.patient_id === patient.id && isValidRecord(r))
    .sort((a, b) => a.date_administered.localeCompare(b.date_administered));

  const series = new Map();
  for (const v of vaccines) {
    if (v.target !== patient.type || v.status === 'inactive') continue;
    if (!series.has(v.code)) series.set(v.code, []);
    series.get(v.code).push(v);
  }

  const items = [];
  for (const doses of series.values()) {
    doses.sort((a, b) => a.dose_number - b.dose_number);
    let prevDate = null;
    let pendingPrev = null;

    for (const vaccine of doses) {
      const record = given.find((r) => r.vaccine_id === vaccine.id);

      // Doses without an age rule (e.g. maternal Td1) are due from registration.
      let due = vaccine.recommended_age && dob ? addPeriod(dob, vaccine.recommended_age) : (prevDate ?? patient.registration_date);
      let earliest = vaccine.min_age && dob ? addPeriod(dob, vaccine.min_age) : dob;
      if (prevDate && vaccine.recommended_interval) {
        const afterInterval = addPeriod(prevDate, vaccine.recommended_interval);
        due = maxISO(due, afterInterval);
        earliest = maxISO(earliest, afterInterval);
      }
      const lastEligible = vaccine.max_age && dob ? addPeriod(dob, vaccine.max_age) : null;

      const item = {
        schedule_id: `${patient.id}:${vaccine.id}`,
        patient_id: patient.id,
        vaccine_id: vaccine.id,
        vaccine_code: vaccine.code,
        dose_number: vaccine.dose_number,
        label: doseLabel(vaccine.code, vaccine.dose_number),
        sort_order: vaccine.sort_order ?? 0,
        expected_due_date: due,
        earliest_date: earliest,
        last_eligible_date: lastEligible,
        status: null,
        record: record ?? null,
        early: false,
        waiting_for: null,
      };

      if (record) {
        item.status = STATUS.COMPLETED;
        item.early = Boolean(earliest) && record.date_administered < earliest;
        prevDate = record.date_administered;
        pendingPrev = null;
      } else if (!isActivePatient(patient)) {
        item.status = STATUS.INACTIVE;
      } else if (lastEligible && today > lastEligible) {
        item.status = STATUS.NOT_ELIGIBLE;
      } else if (pendingPrev) {
        item.status = STATUS.WAITING;
        item.waiting_for = pendingPrev;
        item.expected_due_date = null;
      } else {
        const daysUntil = diffDays(today, due);
        if (today > addDays(due, graceDays)) item.status = STATUS.OVERDUE;
        else if (daysUntil <= 0) item.status = STATUS.DUE;
        else if (daysUntil <= upcomingDays) item.status = STATUS.UPCOMING;
        else item.status = STATUS.SCHEDULED;
        pendingPrev = item.label;
      }
      items.push(item);
    }
  }

  // Same order as the vaccine configuration (and the child health card).
  return items.sort((a, b) => a.sort_order - b.sort_order);
}

// Converts the engine output into Vaccination Schedule rows (section 3.12.7).
export function toScheduleRows(items, now = new Date().toISOString()) {
  return items.map((item) => ({
    id: item.schedule_id,
    patient_id: item.patient_id,
    vaccine_id: item.vaccine_id,
    dose_number: item.dose_number,
    expected_due_date: item.expected_due_date,
    actual_administration_date: item.record?.date_administered ?? null,
    status: item.status,
    earliest_date: item.earliest_date,
    waiting_for: item.waiting_for,
    early: item.early,
    last_updated: now,
  }));
}
