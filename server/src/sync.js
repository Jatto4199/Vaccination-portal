// Server side of the synchronization protocol (thesis sections 3.13 and 3.14).
//
// PUSH: a node sends the records it changed while offline. Each change says
// which server version the node last saw (base_version) and which fields it
// changed. The server then:
//   - applies it directly if nobody else changed the record since then;
//   - otherwise merges field by field and applies the conflict rules below;
//   - logs it as a Synchronization Record; the change_id makes a retried push
//     return the earlier result instead of applying the change twice.
//
// Conflict rules (section 3.14):
//   - non-critical fields (phone, address, name spelling): version/timestamp
//     rule, the change the server receives last wins; the overwritten value
//     is logged as an auto-resolved conflict;
//   - critical fields (date of birth, sex, patient type): the server value is
//     kept and the conflict is flagged for administrative review;
//   - vaccination records are auditable, append-only records: they can be
//     voided with a reason but never overwritten;
//   - the same dose recorded twice, or a likely duplicate patient, is flagged
//     for administrative review; nothing is deleted automatically.
//
// PULL: every accepted change gets the next global server_seq. A node asks for
// everything after the last sequence number it has seen, so device clocks
// never decide the order of changes.

import { randomUUID } from 'node:crypto';
import { SYNC_TABLES, normalizeName, todayISO, addDays } from '@vax/shared';
import { nextServerSeq, currentServerSeq, nowISO } from './db.js';
import { regenerateSchedules } from './schedules.js';

const META_COLUMNS = ['id', 'version', 'server_seq', 'updated_at', 'updated_by_node'];
const REQUIRED = {
  guardians: ['full_name', 'clinic_id'],
  patients: ['patient_number', 'type', 'full_name', 'clinic_id', 'registration_date'],
  vaccination_records: ['patient_id', 'vaccine_id', 'dose_number', 'date_administered', 'clinic_id', 'record_status'],
  audit_log: ['action', 'at'],
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class Rejected extends Error {}

function normalize(value) {
  return value === undefined || value === '' ? null : value;
}

function same(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b) && (a === null) === (b === null);
  return a === b || (a !== null && b !== null && String(a) === String(b));
}

function pickFields(table, source) {
  const data = {};
  for (const f of SYNC_TABLES[table].fields) data[f] = normalize(source[f]);
  return data;
}

const placeholders = (n, start = 1) => Array.from({ length: n }, (_, i) => `$${i + start}`).join(', ');

export async function getRecord(q, table, id) {
  if (!SYNC_TABLES[table]) throw new Error(`Unknown table ${table}`);
  return q.one(`SELECT * FROM ${table} WHERE id = $1`, [id]);
}

// Writes a new version of a record and keeps its history. Returns the stored row.
async function writeRecord(q, table, id, data, { version, isNew, nodeId, userId }) {
  const row = { ...data, id, version, server_seq: await nextServerSeq(q), updated_at: nowISO(), updated_by_node: nodeId ?? null };
  const columns = [...META_COLUMNS, ...SYNC_TABLES[table].fields];
  const values = columns.map((c) => normalize(row[c]));
  if (isNew) {
    await q.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders(columns.length)})`, values);
  } else {
    const sets = columns.slice(1).map((c, i) => `${c} = $${i + 2}`).join(', ');
    await q.query(`UPDATE ${table} SET ${sets} WHERE id = $1`, values);
  }
  await q.query(`INSERT INTO record_versions (table_name, record_id, version, data, node_id, user_id, changed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [table, id, version, JSON.stringify(data), nodeId ?? null, userId ?? null, row.updated_at]);
  return getRecord(q, table, id);
}

async function addConflict(q, c) {
  await q.query(`INSERT INTO conflicts (id, kind, table_name, record_id, other_record_id, field, local_value, server_value,
    rule, status, detail, node_id, user_id, created_at) VALUES (${placeholders(14)})`, [
    randomUUID(), c.kind, c.table_name, c.record_id, c.other_record_id ?? null, c.field ?? null,
    c.local_value == null ? null : String(c.local_value), c.server_value == null ? null : String(c.server_value),
    c.rule, c.status, c.detail ?? null, c.node_id ?? null, c.user_id ?? null, nowISO(),
  ]);
}

export async function serverAudit(q, { user, action, entity = null, entityId = null, detail = null, nodeId = null }) {
  const data = {
    user_id: user?.id ?? null, username: user?.username ?? null, action, entity, entity_id: entityId,
    detail: detail && typeof detail === 'object' ? JSON.stringify(detail) : detail,
    at: nowISO(), clinic_id: user?.clinic_id ?? null, node_id: nodeId,
  };
  await writeRecord(q, 'audit_log', randomUUID(), data, { version: 1, isNew: true, nodeId, userId: user?.id });
}

async function validate(q, table, data, existing, user) {
  for (const f of REQUIRED[table]) {
    if (data[f] === null || data[f] === undefined) throw new Rejected(`Missing ${f}`);
  }
  if (table === 'patients') {
    if (data.type === 'child' && !data.dob) throw new Rejected('Date of birth is required for a child');
    if (data.dob && !ISO_DATE.test(data.dob)) throw new Rejected('Invalid date of birth');
    if (!existing) {
      const taken = await q.one('SELECT 1 FROM patients WHERE patient_number = $1', [data.patient_number]);
      if (taken) throw new Rejected(`Patient number ${data.patient_number} is already in use`);
    }
  }
  if (table === 'vaccination_records') {
    if (!ISO_DATE.test(data.date_administered)) throw new Rejected('Invalid vaccination date');
    // One day of tolerance for nodes in a different timezone.
    if (data.date_administered > addDays(todayISO(), 1)) throw new Rejected('Vaccination date is in the future');
    const vaccine = await q.one('SELECT dose_number FROM vaccines WHERE id = $1', [data.vaccine_id]);
    if (!vaccine) throw new Rejected(`Unknown vaccine ${data.vaccine_id}`);
    if (Number(data.dose_number) !== vaccine.dose_number) throw new Rejected('Dose number does not match the vaccine');
  }
  const clinic = await q.one('SELECT 1 FROM clinics WHERE id = $1', [data.clinic_id]);
  if (table !== 'audit_log' && !clinic) throw new Rejected('Unknown clinic');

  if (user.role === 'admin') return;
  const clinicField = SYNC_TABLES[table].clinicField;
  if (!existing && data[clinicField] !== user.clinic_id) throw new Rejected('Records can only be created for your own clinic');
  if (existing && !same(existing[clinicField], data[clinicField])) throw new Rejected('The clinic of a record cannot be changed');
  if (existing && table === 'vaccination_records' && existing.clinic_id !== user.clinic_id) {
    throw new Rejected('Only the clinic that recorded a vaccination can void it');
  }
  if (table === 'audit_log' && data.user_id !== user.id) throw new Rejected('Audit entries must belong to the current user');
}

export async function flagDuplicates(q, table, row, ctx) {
  const conflict = (kind, otherId, rule, detail) => addConflict(q, {
    kind, table_name: table, record_id: row.id, other_record_id: otherId, rule, status: 'pending', detail,
    node_id: ctx.nodeId, user_id: ctx.user.id,
  });

  if (table === 'patients') {
    // Same name and either the same date of birth or the same guardian phone.
    const candidates = await q.query(`SELECT p.id, p.full_name, p.dob FROM patients p
      LEFT JOIN guardians g ON g.id = p.guardian_id
      WHERE p.type = $1 AND p.id != $2 AND p.merged_into_id IS NULL
        AND (p.dob = $3 OR (g.phone IS NOT NULL AND g.phone = (SELECT phone FROM guardians WHERE id = $4)))`,
    [row.type, row.id, row.dob, row.guardian_id]);
    const name = normalizeName(row.full_name);
    let flagged = 0;
    for (const c of candidates) {
      if (normalizeName(c.full_name) !== name) continue;
      await conflict('possible_duplicate', c.id, 'duplicate-patient-review',
        row.dob && c.dob === row.dob ? 'same name and date of birth' : 'same name and phone number');
      flagged++;
    }
    return flagged;
  }
  if (table === 'vaccination_records' && row.record_status === 'valid') {
    const others = await q.query(`SELECT id FROM vaccination_records WHERE patient_id = $1 AND vaccine_id = $2
      AND record_status = 'valid' AND id != $3`, [row.patient_id, row.vaccine_id, row.id]);
    for (const other of others) {
      await conflict('duplicate_dose', other.id, 'duplicate-dose-review', `${row.vaccine_id} recorded twice`);
    }
    return others.length;
  }
  return 0;
}

async function applyOne(q, ctx, change) {
  const { table, record } = change;
  const spec = SYNC_TABLES[table];
  if (!spec) throw new Rejected(`Unknown table ${table}`);
  if (!record?.id) throw new Rejected('Record id is required');

  const existing = await getRecord(q, table, record.id);
  const incoming = pickFields(table, record);

  if (!existing) {
    await validate(q, table, incoming, null, ctx.user);
    const row = await writeRecord(q, table, record.id, incoming, { version: 1, isNew: true, nodeId: ctx.nodeId, userId: ctx.user.id });
    const flagged = await flagDuplicates(q, table, row, ctx);
    return { status: flagged ? 'flagged' : 'applied', change_type: 'create', conflict_status: flagged ? 'pending_review' : 'none', record: row };
  }

  const current = pickFields(table, existing);
  const allowed = spec.appendOnly ? spec.mutable : spec.fields;
  const changed = (change.changed_fields ?? spec.fields).filter((f) => spec.fields.includes(f) && !same(current[f], incoming[f]));
  const forbidden = changed.filter((f) => !allowed.includes(f));
  if (forbidden.length) {
    throw new Rejected(`${table} cannot be edited (${forbidden.join(', ')}); void the record and create a new one instead`);
  }
  const changeType = table === 'vaccination_records' && incoming.record_status === 'voided' && current.record_status !== 'voided'
    ? 'void' : 'update';

  const merged = { ...current };
  let pending = 0;
  let auto = 0;
  const concurrent = existing.version !== change.base_version;
  const base = concurrent && change.base_version > 0
    ? (await q.one('SELECT data FROM record_versions WHERE table_name = $1 AND record_id = $2 AND version = $3',
      [table, record.id, change.base_version]))?.data
    : null;

  for (const f of changed) {
    const serverChanged = concurrent && (!base || !same(base[f], current[f]));
    const conflict = { kind: 'field', table_name: table, record_id: record.id, field: f, local_value: incoming[f],
      server_value: current[f], node_id: ctx.nodeId, user_id: ctx.user.id };
    if (!serverChanged) {
      merged[f] = incoming[f];
    } else if (spec.critical.includes(f)) {
      pending++;
      await addConflict(q, { ...conflict, rule: 'critical-field-review', status: 'pending' });
    } else {
      auto++;
      merged[f] = incoming[f];
      await addConflict(q, { ...conflict, rule: 'last-received-wins', status: 'auto_resolved' });
    }
  }

  await validate(q, table, merged, existing, ctx.user);
  const outcome = {
    status: pending ? 'conflict' : concurrent ? 'merged' : 'applied',
    change_type: changeType,
    conflict_status: pending ? 'pending_review' : auto ? 'auto_resolved' : 'none',
  };
  if (changed.every((f) => same(merged[f], current[f]))) return { ...outcome, record: existing };
  const row = await writeRecord(q, table, record.id, merged, {
    version: existing.version + 1, isNew: false, nodeId: ctx.nodeId, userId: ctx.user.id,
  });
  return { ...outcome, record: row };
}

async function logSyncRecord(q, ctx, change, outcome) {
  await q.query(`INSERT INTO sync_records (id, change_id, table_name, record_id, node_id, clinic_id, user_id, change_type,
    version_number, timestamp, sync_status, conflict_status, error, result) VALUES (${placeholders(14)})`, [
    randomUUID(), change.change_id, change.table, change.record?.id ?? '', ctx.nodeId, ctx.user.clinic_id, ctx.user.id,
    outcome.change_type ?? change.change_type ?? 'update', outcome.record?.version ?? null, nowISO(),
    outcome.status === 'rejected' ? 'rejected' : 'applied', outcome.conflict_status ?? 'none', outcome.error ?? null,
    JSON.stringify({ table: change.table, id: change.record?.id, status: outcome.status, change_type: outcome.change_type,
      conflict_status: outcome.conflict_status, error: outcome.error }),
  ]);
}

async function markClinicSync(q, user, ok) {
  if (!user.clinic_id) return;
  await q.query('UPDATE clinics SET sync_status = $1, last_sync_at = $2 WHERE id = $3', [ok ? 'synced' : 'failed', nowISO(), user.clinic_id]);
}

// Applies a batch of changes from a node. Each change is applied in its own
// transaction so one invalid record cannot block the rest.
export async function pushChanges(db, ctx, changes) {
  const results = [];
  const counts = {};
  const affectedPatients = new Set();

  for (const change of changes) {
    if (!change.change_id) throw Object.assign(new Error('change_id is required'), { status: 400 });
    const done = await db.one('SELECT result FROM sync_records WHERE change_id = $1', [change.change_id]);
    if (done) {
      const latest = done.result.status !== 'rejected' ? await getRecord(db, change.table, done.result.id) : null;
      results.push({ ...done.result, record: latest, replayed: true });
      continue;
    }

    let result;
    try {
      result = await db.tx(async (q) => {
        const outcome = await applyOne(q, ctx, change);
        await logSyncRecord(q, ctx, change, outcome);
        return { table: change.table, id: change.record.id, ...outcome };
      });
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      result = { table: change.table, id: change.record?.id, status: 'rejected', conflict_status: 'none', error: err.message };
      await logSyncRecord(db, ctx, change, result);
    }
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    if (result.record && change.table === 'patients') affectedPatients.add(result.record.id);
    if (result.record && change.table === 'vaccination_records') affectedPatients.add(result.record.patient_id);
    results.push(result);
  }

  await db.tx(async (q) => {
    if (affectedPatients.size) await regenerateSchedules(q, [...affectedPatients]);
    if (changes.length) {
      await markClinicSync(q, ctx.user, !counts.rejected);
      await serverAudit(q, { user: ctx.user, action: 'sync.push', nodeId: ctx.nodeId, detail: { received: changes.length, ...counts } });
    }
  });
  return results;
}

// Returns changes after `since` that the user's clinic needs, in server order.
export async function pullChanges(db, user, since, limit = 500) {
  // Read the current sequence first so a change committed while this request
  // runs is picked up by the next pull instead of being skipped.
  const upTo = await currentServerSeq(db);
  const scoped = user.role !== 'admin';
  // A clinic receives its own patients plus visiting patients it has vaccinated.
  const myPatients = `SELECT id FROM patients WHERE clinic_id = $3
    UNION SELECT patient_id FROM vaccination_records WHERE clinic_id = $3`;
  const range = 'server_seq > $1 AND server_seq <= $2';
  const queries = {
    patients: scoped ? `SELECT * FROM patients WHERE ${range} AND id IN (${myPatients})` : `SELECT * FROM patients WHERE ${range}`,
    guardians: scoped
      ? `SELECT * FROM guardians WHERE ${range} AND (clinic_id = $3 OR id IN (SELECT guardian_id FROM patients WHERE id IN (${myPatients})))`
      : `SELECT * FROM guardians WHERE ${range}`,
    vaccination_records: scoped
      ? `SELECT * FROM vaccination_records WHERE ${range} AND (clinic_id = $3 OR patient_id IN (${myPatients}))`
      : `SELECT * FROM vaccination_records WHERE ${range}`,
  };

  let changes = [];
  for (const [table, sql] of Object.entries(queries)) {
    const params = scoped ? [since, upTo, user.clinic_id, limit + 1] : [since, upTo, limit + 1];
    const rows = await db.query(`${sql} ORDER BY server_seq LIMIT $${params.length}`, params);
    changes.push(...rows.map((record) => ({ table, record })));
  }
  changes.sort((a, b) => a.record.server_seq - b.record.server_seq);
  const more = changes.length > limit;
  changes = changes.slice(0, limit);
  await db.tx((q) => markClinicSync(q, user, true));
  return { changes, last_seq: more ? changes.at(-1).record.server_seq : upTo, more };
}

// Server-side edit made by an administrator (conflict resolution, merges).
export async function serverUpdate(q, ctx, table, id, patch) {
  const existing = await getRecord(q, table, id);
  if (!existing) throw new Error(`${table} ${id} not found`);
  return writeRecord(q, table, id, { ...pickFields(table, existing), ...patch }, {
    version: existing.version + 1, isNew: false, nodeId: ctx.nodeId ?? 'server', userId: ctx.user.id,
  });
}

// Inserts a record created on the server (used by the demo data seeder).
export async function serverCreate(q, ctx, table, data) {
  const id = data.id ?? randomUUID();
  return writeRecord(q, table, id, pickFields(table, data), { version: 1, isNew: true, nodeId: ctx.nodeId ?? 'server', userId: ctx.user?.id });
}
