import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule, toScheduleRows, STATUS } from '../schedule.js';
import { DEFAULT_VACCINES } from '../schedule-data.js';
import { addPeriod, addMonths, diffDays } from '../dates.js';

const V = DEFAULT_VACCINES;
const child = { id: 'c1', type: 'child', dob: '2026-01-01', registration_date: '2026-01-01' };
const mother = { id: 'm1', type: 'mother', dob: '1998-05-10', registration_date: '2026-03-01' };
const rec = (vaccine_id, date_administered, extra = {}) =>
  ({ id: vaccine_id, patient_id: 'c1', vaccine_id, date_administered, record_status: 'valid', ...extra });
const find = (items, id) => items.find((i) => i.vaccine_id === id);

test('date arithmetic clamps month ends and handles periods', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addPeriod('2026-01-01', '6w'), '2026-02-12');
  assert.equal(addPeriod('2026-01-01', '9m'), '2026-10-01');
  assert.equal(diffDays('2026-01-01', '2026-02-12'), 42);
});

test('expected due date = date of birth + recommended age', () => {
  const items = computeSchedule(child, [], V, { today: '2026-01-01' });
  assert.equal(find(items, 'BCG-1').expected_due_date, '2026-01-01');
  assert.equal(find(items, 'BCG-1').status, STATUS.DUE);
  assert.equal(find(items, 'PENTA-1').expected_due_date, '2026-02-12');
  assert.equal(find(items, 'PENTA-1').status, STATUS.SCHEDULED);
  assert.equal(find(items, 'MCV-1').expected_due_date, '2026-10-01');
  assert.equal(find(items, 'PENTA-2').status, STATUS.WAITING);
  assert.equal(find(items, 'PENTA-2').waiting_for, 'PENTA 1');
});

test('upcoming and overdue are classified relative to today', () => {
  assert.equal(find(computeSchedule(child, [], V, { today: '2026-02-08' }), 'PENTA-1').status, STATUS.UPCOMING);
  assert.equal(find(computeSchedule(child, [], V, { today: '2026-02-20' }), 'PENTA-1').status, STATUS.OVERDUE);
  // With a grace period the dose stays "due" for a few days.
  assert.equal(find(computeSchedule(child, [], V, { today: '2026-02-14', graceDays: 3 }), 'PENTA-1').status, STATUS.DUE);
});

test('catch-up: a later dose uses the previous dose + recommended interval', () => {
  const items = computeSchedule(child, [rec('PENTA-1', '2026-04-01')], V, { today: '2026-04-01' });
  assert.equal(find(items, 'PENTA-1').status, STATUS.COMPLETED);
  assert.equal(find(items, 'PENTA-2').expected_due_date, '2026-04-29');
  assert.equal(find(items, 'PENTA-2').status, STATUS.SCHEDULED);
});

test('birth doses past their age limit become not eligible and do not block later doses', () => {
  const items = computeSchedule(child, [], V, { today: '2026-03-01' });
  assert.equal(find(items, 'OPV-0').status, STATUS.NOT_ELIGIBLE);
  assert.equal(find(items, 'HEPB-0').status, STATUS.NOT_ELIGIBLE);
  assert.equal(find(items, 'OPV-1').status, STATUS.OVERDUE);
});

test('voided records do not count and inactive vaccines are skipped', () => {
  const items = computeSchedule(child, [rec('BCG-1', '2026-01-01', { record_status: 'voided' })], V, { today: '2026-01-05' });
  assert.equal(find(items, 'BCG-1').status, STATUS.OVERDUE);
  const withoutYF = V.map((v) => (v.code === 'YF' ? { ...v, status: 'inactive' } : v));
  assert.equal(find(computeSchedule(child, [], withoutYF), 'YF-1'), undefined);
});

test('doses given before the minimum age are flagged as early', () => {
  const items = computeSchedule(child, [rec('PENTA-1', '2026-01-20')], V, { today: '2026-02-01' });
  assert.equal(find(items, 'PENTA-1').early, true);
});

test('maternal Td is scheduled from registration and by interval', () => {
  const items = computeSchedule(mother, [], V, { today: '2026-03-01' });
  assert.equal(items.length, 5);
  assert.equal(find(items, 'TD-1').expected_due_date, '2026-03-01');
  const withTd1 = computeSchedule(mother, [{ ...rec('TD-1', '2026-03-01'), patient_id: 'm1' }], V, { today: '2026-03-02' });
  assert.equal(find(withTd1, 'TD-2').expected_due_date, '2026-03-29');
});

test('schedule rows carry the Vaccination Schedule attributes', () => {
  const [row] = toScheduleRows(computeSchedule(child, [rec('BCG-1', '2026-01-03')], V, { today: '2026-01-05' }), 'now');
  assert.deepEqual(
    { id: row.id, vaccine_id: row.vaccine_id, dose_number: row.dose_number, expected_due_date: row.expected_due_date,
      actual_administration_date: row.actual_administration_date, status: row.status, last_updated: row.last_updated },
    { id: 'c1:BCG-1', vaccine_id: 'BCG-1', dose_number: 1, expected_due_date: '2026-01-01',
      actual_administration_date: '2026-01-03', status: STATUS.COMPLETED, last_updated: 'now' },
  );
});
