// Central database (PostgreSQL).
//
// Production (e.g. Vercel + Neon): set DATABASE_URL and the `pg` driver is used.
// Development and tests: without DATABASE_URL an embedded PostgreSQL (PGlite)
// is used, stored in server/data/pgdata (or in memory for tests), so the
// project runs with no database server to install.
//
// Every function receives an executor `q` with `query(sql, params)` returning
// rows and `one(sql, params)` returning the first row or null. `db.tx(fn)` runs
// `fn(q)` inside a transaction.

import pg from 'pg';
import { mkdirSync } from 'node:fs';
import { DEFAULT_VACCINES, DEFAULT_SETTINGS } from '../shared/index.js';

const DATE_OID = 1082;
const TIMESTAMPTZ_OID = 1184;
const INT8_OID = 20;
const parsers = {
  [DATE_OID]: (v) => v,
  [TIMESTAMPTZ_OID]: (v) => new Date(v).toISOString(),
  [INT8_OID]: (v) => Number(v),
};

function executor(run) {
  return {
    query: async (sql, params = []) => (await run(sql, params)).rows,
    one: async (sql, params = []) => (await run(sql, params)).rows[0] ?? null,
  };
}

async function connectPg(url) {
  for (const [oid, fn] of Object.entries(parsers)) pg.types.setTypeParser(Number(oid), fn);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX ?? 5),
  });
  return {
    kind: 'postgres',
    ...executor((sql, params) => pool.query(sql, params)),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(executor((sql, params) => client.query(sql, params)));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    exec: (sql) => pool.query(sql),
    close: () => pool.end(),
  };
}

async function connectPglite(dataDir) {
  // Loaded only when needed so production deployments don't load the WASM build.
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create(dataDir ?? undefined, { parsers });
  return {
    kind: 'pglite',
    ...executor((sql, params) => db.query(sql, params)),
    tx: (fn) => db.transaction((tx) => fn(executor((sql, params) => tx.query(sql, params)))),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

// Columns shared by every synchronized table (section 3.13 metadata).
const SYNC_META = `
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  server_seq INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_node TEXT
`;

// Synced tables reference each other logically but have no foreign keys
// between them: nodes send records independently and in any order, and an
// offline-created child may reach the server before its guardian.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS clinics (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  node_id TEXT NOT NULL UNIQUE,
  sync_status TEXT NOT NULL DEFAULT 'never_synced' CHECK (sync_status IN ('never_synced', 'synced', 'failed')),
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('health_worker', 'admin')),
  clinic_id TEXT REFERENCES clinics(id),
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'disabled')),
  date_created TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vaccines (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  dose_number INTEGER NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('child', 'mother')),
  recommended_age TEXT,
  recommended_interval TEXT,
  min_age TEXT,
  max_age TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  UNIQUE (code, dose_number, target)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS guardians (
  ${SYNC_META},
  full_name TEXT NOT NULL,
  relationship TEXT,
  phone TEXT,
  address TEXT,
  id_number TEXT,
  preferred_notification TEXT,
  sms_consent BOOLEAN NOT NULL DEFAULT false,
  patient_id TEXT,
  clinic_id TEXT NOT NULL REFERENCES clinics(id)
);

CREATE TABLE IF NOT EXISTS patients (
  ${SYNC_META},
  patient_number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('child', 'mother')),
  full_name TEXT NOT NULL,
  dob DATE,
  sex TEXT CHECK (sex IN ('F', 'M')),
  address TEXT,
  guardian_id TEXT,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  registration_date DATE NOT NULL,
  registered_by TEXT,
  merged_into_id TEXT
);
CREATE INDEX IF NOT EXISTS patients_clinic ON patients(clinic_id);
CREATE INDEX IF NOT EXISTS patients_dob ON patients(dob);

CREATE TABLE IF NOT EXISTS vaccination_records (
  ${SYNC_META},
  patient_id TEXT NOT NULL,
  vaccine_id TEXT NOT NULL REFERENCES vaccines(id),
  dose_number INTEGER NOT NULL,
  date_administered DATE NOT NULL,
  administered_by TEXT,
  administered_by_name TEXT,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  batch_number TEXT,
  record_status TEXT NOT NULL DEFAULT 'valid' CHECK (record_status IN ('valid', 'voided')),
  void_reason TEXT,
  voided_by TEXT,
  voided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS records_patient ON vaccination_records(patient_id);

CREATE TABLE IF NOT EXISTS audit_log (
  ${SYNC_META},
  user_id TEXT,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  at TIMESTAMPTZ NOT NULL,
  clinic_id TEXT,
  node_id TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);

-- Vaccination Schedule (section 3.12.7): derived from patients, vaccines and
-- vaccination records, regenerated on every node rather than synchronized.
CREATE TABLE IF NOT EXISTS vaccination_schedules (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  vaccine_id TEXT NOT NULL REFERENCES vaccines(id),
  dose_number INTEGER NOT NULL,
  expected_due_date DATE,
  actual_administration_date DATE,
  status TEXT NOT NULL,
  earliest_date DATE,
  waiting_for TEXT,
  early BOOLEAN NOT NULL DEFAULT false,
  last_updated TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_patient ON vaccination_schedules(patient_id);
CREATE INDEX IF NOT EXISTS schedules_status ON vaccination_schedules(status, expected_due_date);

-- Synchronization Record (section 3.12.8): one row per change received from a
-- node. change_id makes retried pushes idempotent.
CREATE TABLE IF NOT EXISTS sync_records (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL UNIQUE,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  node_id TEXT,
  clinic_id TEXT,
  user_id TEXT,
  change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update', 'void')),
  version_number INTEGER,
  timestamp TIMESTAMPTZ NOT NULL,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('applied', 'rejected')),
  conflict_status TEXT NOT NULL CHECK (conflict_status IN ('none', 'auto_resolved', 'pending_review')),
  error TEXT,
  result JSONB
);
CREATE INDEX IF NOT EXISTS sync_records_time ON sync_records(timestamp);

-- Every accepted version of every synced record, so conflicts can be detected
-- field by field and every change can be traced.
CREATE TABLE IF NOT EXISTS record_versions (
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data JSONB NOT NULL,
  node_id TEXT,
  user_id TEXT,
  changed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (table_name, record_id, version)
);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('field', 'duplicate_dose', 'possible_duplicate')),
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  other_record_id TEXT,
  field TEXT,
  local_value TEXT,
  server_value TEXT,
  rule TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'auto_resolved', 'resolved')),
  detail TEXT,
  node_id TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS conflicts_status ON conflicts(status);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  guardian_id TEXT,
  vaccine_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('upcoming', 'due', 'overdue')),
  channel TEXT NOT NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (patient_id, vaccine_id, type)
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('server_seq', 0) ON CONFLICT DO NOTHING;
`;

export async function openDatabase({ url = process.env.DATABASE_URL, dataDir } = {}) {
  const db = url ? await connectPg(url) : await connectPglite(dataDir);
  await db.exec(SCHEMA);
  await seedReferenceData(db);
  return db;
}

function multiRowInsert(table, columns, rows) {
  const params = rows.flatMap((row) => columns.map((c) => row[c] ?? null));
  const tuples = rows.map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`);
  return [`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params];
}

// Default vaccines and settings; existing rows (possibly edited by an administrator) are kept.
async function seedReferenceData(db) {
  await db.query(...multiRowInsert('vaccines', ['id', 'code', 'name', 'dose_number', 'target', 'recommended_age',
    'recommended_interval', 'min_age', 'max_age', 'sort_order', 'status'], DEFAULT_VACCINES));
  await db.query(...multiRowInsert('settings', ['key', 'value'],
    Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value: JSON.stringify(value) }))));
}

export async function getSettings(q) {
  const rows = await q.query('SELECT key, value FROM settings');
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

// Taking the next sequence number locks the counter row until the transaction
// commits, so changes become visible to pulling nodes in sequence order.
export async function nextServerSeq(q) {
  return (await q.one("UPDATE counters SET value = value + 1 WHERE name = 'server_seq' RETURNING value")).value;
}

export async function currentServerSeq(q) {
  return (await q.one("SELECT value FROM counters WHERE name = 'server_seq'")).value;
}

export const nowISO = () => new Date().toISOString();
