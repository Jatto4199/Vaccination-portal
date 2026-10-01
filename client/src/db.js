// Local Storage Module / Local Data Layer (thesis section 3.7.3): IndexedDB via Dexie.
//
// Synced tables (patients, guardians, vaccination_records) hold the latest
// copy of each record plus `version`, the last server version this node has
// seen (0 = never synced).
//
// sync_records is the Synchronization Record entity (section 3.12.8): every
// local change adds one row with sync_status "pending". The sync process sends
// pending changes and marks them "synced" (or "failed"), so nothing entered
// offline is lost if the network drops.
//
// vaccination_schedules (section 3.12.7) and notifications are derived on this
// node from the records above.

import Dexie from 'dexie';

export const db = new Dexie('vax-registry');

db.version(1).stores({
  patients: 'id, patient_number, type, guardian_id, clinic_id',
  guardians: 'id, phone, patient_id',
  vaccination_records: 'id, patient_id, date_administered',
  vaccination_schedules: 'id, patient_id, status, expected_due_date',
  sync_records: 'id, sync_status, record_id, timestamp',
  notifications: 'id, read, created_at, schedule_id',
  audit_log: 'id, at, synced',
  clinics: 'id',
  vaccines: 'id',
  meta: 'key',
});

export const SYNCED_TABLES = ['guardians', 'patients', 'vaccination_records'];
export const DATA_TABLES = [...SYNCED_TABLES, 'vaccination_schedules', 'sync_records', 'notifications', 'audit_log'];

export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  return db.meta.put({ key, value });
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// A random identifier for this installation, created once.
export async function getDeviceId() {
  let id = await getMeta('deviceId');
  if (!id) {
    id = uuid();
    await setMeta('deviceId', id);
  }
  return id;
}

// Node identifier (sections 3.12.2, 3.13): clinic code + device code.
export async function getNodeId() {
  return (await getMeta('nodeId')) ?? `NODE-${(await getDeviceId()).slice(0, 4).toUpperCase()}`;
}

// Number of records with changes waiting to be synchronized.
export async function pendingCount() {
  const pending = await db.sync_records.where('sync_status').equals('pending').toArray();
  return new Set(pending.map((s) => s.record_id)).size;
}

// Removes all patient data from this node (used when a different clinic logs
// in). Callers must first make sure nothing is waiting to sync.
export async function clearPatientData() {
  await db.transaction('rw', [...DATA_TABLES.map((t) => db[t]), db.meta], async () => {
    for (const t of DATA_TABLES) await db[t].clear();
    for (const key of ['lastSeq', 'lastSyncAt', 'schedulesRefreshedOn']) await db.meta.delete(key);
  });
}
