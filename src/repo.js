// Patient Registration, Guardian Management and Vaccination Management on the
// node (thesis sections 3.8, 3.9). Every write, in one IndexedDB transaction:
//   1. saves the record locally (works offline),
//   2. adds a pending Synchronization Record for the change,
//   3. adds an audit entry;
// then regenerates the patient's vaccination schedule and asks for a sync.

import { SYNC_TABLES, todayISO } from '../shared/index.js';
import { db, uuid, getMeta, getNodeId, getDeviceId } from './db.js';
import { getSession } from './auth.js';
import { refreshSchedules } from './schedules.js';
import { scheduleSync } from './sync.js';

function same(a, b) {
  const norm = (v) => (v === undefined || v === '' ? null : v);
  return norm(a) === norm(b) || String(norm(a)) === String(norm(b));
}

function pick(source, fields) {
  return Object.fromEntries(fields.filter((f) => f in source).map((f) => [f, source[f]]));
}

function currentUser() {
  const user = getSession()?.user;
  if (!user) throw new Error('Not logged in');
  return user;
}

const writeTables = () => [db.patients, db.guardians, db.vaccination_records, db.sync_records, db.audit_log, db.meta, db.clinics];

// Inserts or updates one synced record inside the caller's transaction.
async function saveRecord(table, values, ctx, changeType) {
  const fields = SYNC_TABLES[table].fields;
  const existing = values.id ? await db[table].get(values.id) : null;
  const now = new Date().toISOString();
  let id;
  let changed;

  if (!existing) {
    id = values.id ?? uuid();
    changed = fields;
    await db[table].add({ ...pick(values, fields), id, version: 0, updated_at: now });
  } else {
    id = existing.id;
    changed = fields.filter((f) => f in values && !same(values[f], existing[f]));
    if (!changed.length) return id;
    await db[table].put({ ...existing, ...pick(values, changed), updated_at: now, _sync_error: null });
  }

  const type = changeType ?? (existing ? 'update' : 'create');
  await db.sync_records.add({
    id: uuid(), record_id: id, table_name: table, node_id: ctx.nodeId, change_type: type,
    version_number: existing?.version ?? 0, timestamp: now, sync_status: 'pending', conflict_status: 'none',
    changed_fields: changed, error: null,
  });
  await db.audit_log.add({
    id: uuid(), user_id: ctx.user.id, username: ctx.user.username, action: `${table}.${type}`, entity: table, entity_id: id,
    detail: existing ? JSON.stringify({ fields: changed }) : null, at: now, clinic_id: ctx.user.clinic_id,
    node_id: ctx.nodeId, synced: 0,
  });
  return id;
}

async function context() {
  return { user: currentUser(), nodeId: await getNodeId() };
}

async function nextPatientNumber(user) {
  // Clinic code + device code + local counter: unique without contacting the server.
  const clinic = await db.clinics.get(user.clinic_id);
  const device = (await getDeviceId()).slice(0, 4).toUpperCase();
  const n = (await getMeta('patientCounter', 0)) + 1;
  await db.meta.put({ key: 'patientCounter', value: n });
  return `${clinic?.code ?? 'CLN'}-${device}-${String(n).padStart(4, '0')}`;
}

async function afterWrite(patientIds) {
  await refreshSchedules(patientIds);
  scheduleSync();
}

// Registers a child with a guardian, or a mother for maternal vaccination.
// A mother's contact details live in a guardian record linked to her own
// patient record, so children and mothers are contacted the same way.
export async function registerPatient({ patient, guardian, existingGuardianId, registerMother }) {
  const ctx = await context();
  const { user } = ctx;
  if (!user.clinic_id) throw new Error('Only clinic staff can register patients');
  const today = todayISO();
  const created = [];

  const newPatient = async (values) => {
    const id = await saveRecord('patients', {
      ...values, patient_number: await nextPatientNumber(user), clinic_id: user.clinic_id,
      registration_date: today, registered_by: user.id,
    }, ctx);
    created.push(id);
    return id;
  };

  const id = await db.transaction('rw', writeTables(), async () => {
    let guardianId = existingGuardianId ?? null;
    if (!guardianId) guardianId = await saveRecord('guardians', { ...guardian, clinic_id: user.clinic_id }, ctx);

    if (patient.type === 'mother') {
      const motherId = await newPatient({ ...patient, guardian_id: guardianId });
      await saveRecord('guardians', { id: guardianId, patient_id: motherId }, ctx);
      return motherId;
    }
    if (registerMother) {
      const g = await db.guardians.get(guardianId);
      if (!g.patient_id) {
        const motherId = await newPatient({ type: 'mother', full_name: g.full_name, address: g.address, guardian_id: guardianId });
        await saveRecord('guardians', { id: guardianId, patient_id: motherId }, ctx);
      }
    }
    return newPatient({ ...patient, guardian_id: guardianId });
  });
  await afterWrite(created);
  return id;
}

export async function updateRecord(table, values) {
  const ctx = await context();
  const id = await db.transaction('rw', writeTables(), () => saveRecord(table, values, ctx));
  const patientIds = table === 'patients' ? [id]
    : table === 'guardians' ? (await db.patients.where('guardian_id').equals(id).toArray()).map((p) => p.id)
      : [(await db.vaccination_records.get(id)).patient_id];
  await afterWrite(patientIds);
  return id;
}

// givenElsewhere: a dose given at another facility, copied from the child
// health card. It counts for the schedule and coverage but not as a dose
// given by this clinic. The record still belongs to this clinic (it entered it).
export async function recordVaccination({ patientId, vaccine, dateAdministered, batchNumber, givenElsewhere = false, facilityName }) {
  const ctx = await context();
  if (!ctx.user.clinic_id) throw new Error('Only clinic staff can record vaccinations');
  const id = await db.transaction('rw', writeTables(), () => saveRecord('vaccination_records', {
    patient_id: patientId, vaccine_id: vaccine.id, dose_number: vaccine.dose_number, date_administered: dateAdministered,
    batch_number: batchNumber || null,
    administered_by: givenElsewhere ? null : ctx.user.id, administered_by_name: givenElsewhere ? null : ctx.user.full_name,
    given_elsewhere: givenElsewhere, facility_name: givenElsewhere ? facilityName || null : null,
    clinic_id: ctx.user.clinic_id, record_status: 'valid',
  }, ctx));
  await afterWrite([patientId]);
  return id;
}

// Vaccination records are auditable: a mistaken record is voided with a
// reason and stays in the history; it is never edited or deleted.
export async function voidVaccination(record, reason) {
  const ctx = await context();
  await db.transaction('rw', writeTables(), () => saveRecord('vaccination_records', {
    id: record.id, record_status: 'voided', void_reason: reason, voided_by: ctx.user.id, voided_at: new Date().toISOString(),
  }, ctx, 'void'));
  await afterWrite([record.patient_id]);
}

// Stores a patient from another clinic (fetched online) on this node.
export async function importPatientBundle({ patient, guardian, records }) {
  await db.transaction('rw', db.patients, db.guardians, db.vaccination_records, async () => {
    if (guardian && !(await db.guardians.get(guardian.id))) await db.guardians.put(guardian);
    if (!(await db.patients.get(patient.id))) await db.patients.put(patient);
    for (const r of records) if (!(await db.vaccination_records.get(r.id))) await db.vaccination_records.put(r);
  });
  await refreshSchedules([patient.id]);
}
