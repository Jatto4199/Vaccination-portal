import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db.js';
import { createApp } from '../app.js';
import { seedDemoData } from '../seed.js';
import { runReminders } from '../reminders.js';
import { addDays, todayISO } from '../../shared/index.js';

const quietSender = { channel: 'sms', send: async () => ({ status: 'sent_simulated' }) };

// Runs against the in-memory embedded PostgreSQL, or a real PostgreSQL server
// when TEST_DATABASE_URL is set (its public schema is wiped first).
async function freshDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const wipe = await openDatabase({ url });
    await wipe.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await wipe.close();
  }
  return openDatabase({ url: url ?? null });
}

async function startServer() {
  const db = await freshDatabase();
  await seedDemoData(db);
  const app = createApp({ getDb: async () => db, jwtSecret: 'test-secret', cronSecret: 'cron-secret', sender: quietSender });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const clinics = await db.query('SELECT * FROM clinics ORDER BY code');
  return { db, server, base, clinics };
}

// A minimal stand-in for a clinic node.
async function node(env, username, password) {
  const nodeId = `NODE-TEST-${randomUUID().slice(0, 4)}`;
  const login = await fetch(`${env.base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-node-id': nodeId },
    body: JSON.stringify({ username, password }),
  }).then((r) => r.json());
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, 'x-node-id': nodeId };
  return {
    user: login.user,
    push: (changes) => fetch(`${env.base}/sync/push`, { method: 'POST', headers, body: JSON.stringify({ changes }) })
      .then((r) => r.json()).then((b) => b.results),
    pull: (since = 0) => fetch(`${env.base}/sync/pull?since=${since}`, { headers }).then((r) => r.json()),
    get: (path) => fetch(`${env.base}${path}`, { headers }).then((r) => r.json()),
    send: (method, path, body) => fetch(`${env.base}${path}`, { method, headers, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() })),
  };
}

let counter = 0;
// Letters only: duplicate detection ignores digits in names.
const uniqueName = (n) => `Child ${n.toString(26).split('').map((d) => String.fromCharCode(97 + parseInt(d, 26))).join('')}`;
const childRecord = (clinicId, overrides = {}) => ({
  id: randomUUID(), patient_number: `TEST-${++counter}`, type: 'child', full_name: uniqueName(counter),
  dob: '2026-01-10', sex: 'M', address: 'Iloro', clinic_id: clinicId, registration_date: '2026-01-10', ...overrides,
});
const dose = (patientId, clinicId, vaccineId, date, extra = {}) => ({
  id: randomUUID(), patient_id: patientId, vaccine_id: vaccineId, dose_number: Number(vaccineId.split('-')[1]),
  date_administered: date, clinic_id: clinicId, record_status: 'valid', ...extra,
});
const create = (table, record) => ({ change_id: randomUUID(), change_type: 'create', table, record, base_version: 0 });
const update = (table, record, baseVersion, fields) =>
  ({ change_id: randomUUID(), change_type: 'update', table, record, base_version: baseVersion, changed_fields: fields });

test('central server', async (t) => {
  const env = await startServer();
  t.after(async () => { env.server.close(); await env.db.close(); });
  const [clinicA, clinicB] = env.clinics;
  const nurseA = await node(env, 'nurse1', '1234567890');
  const nurseA2 = await node(env, 'chew1', '1234567890'); // second health worker at clinic A
  const nurseB = await node(env, 'nurse2', '1234567890');
  const admin = await node(env, 'admin', '1234567890');

  await t.test('demo data has patients with due, upcoming and overdue doses', async () => {
    const counts = Object.fromEntries((await env.db.query(
      'SELECT status, COUNT(*)::int AS n FROM vaccination_schedules GROUP BY status')).map((r) => [r.status, r.n]));
    assert.ok(counts.completed > 50, `completed: ${counts.completed}`);
    assert.ok(counts.overdue > 0);
    assert.ok((await env.db.one('SELECT COUNT(*)::int AS n FROM patients')).n >= 50);
    assert.equal((await env.db.one("SELECT COUNT(*)::int AS n FROM conflicts WHERE status = 'pending'")).n, 1);
  });

  await t.test('login works with username or email and fails with a wrong password', async () => {
    const bad = await fetch(`${env.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nurse1', password: 'nope' }) });
    assert.equal(bad.status, 401);
    const byEmail = await node(env, 'NURSE1@example.org', '1234567890');
    assert.equal(byEmail.user.username, 'nurse1');
  });

  await t.test('a new record is applied, logged as a sync record and pulled only by its clinic', async () => {
    const patient = childRecord(clinicA.id);
    const [result] = await nurseA.push([create('patients', patient)]);
    assert.equal(result.status, 'applied');
    assert.equal(result.record.version, 1);
    const log = await env.db.one('SELECT * FROM sync_records WHERE record_id = $1', [patient.id]);
    assert.equal(log.change_type, 'create');
    assert.equal(log.sync_status, 'applied');
    assert.equal(log.conflict_status, 'none');
    assert.ok((await nurseA2.pull(0)).changes.some((c) => c.record.id === patient.id));
    assert.ok(!(await nurseB.pull(0)).changes.some((c) => c.record.id === patient.id));
    const clinic = await env.db.one('SELECT sync_status, last_sync_at FROM clinics WHERE id = $1', [clinicA.id]);
    assert.equal(clinic.sync_status, 'synced');
    assert.ok(clinic.last_sync_at);
  });

  await t.test('the server stores a vaccination schedule for each synced patient', async () => {
    const patient = childRecord(clinicA.id);
    await nurseA.push([create('patients', patient), create('vaccination_records', dose(patient.id, clinicA.id, 'BCG-1', '2026-01-10'))]);
    const rows = await env.db.query('SELECT * FROM vaccination_schedules WHERE patient_id = $1', [patient.id]);
    assert.equal(rows.length, 21);
    const bcg = rows.find((r) => r.vaccine_id === 'BCG-1');
    assert.equal(bcg.status, 'completed');
    assert.equal(bcg.actual_administration_date, '2026-01-10');
  });

  await t.test('a retried push is not applied twice', async () => {
    const change = create('patients', childRecord(clinicA.id));
    const [first] = await nurseA.push([change]);
    const [second] = await nurseA.push([change]);
    assert.equal(first.status, 'applied');
    assert.equal(second.replayed, true);
    assert.equal(second.record.version, 1);
  });

  await t.test('a health worker cannot create records for another clinic', async () => {
    const [result] = await nurseA.push([create('patients', childRecord(clinicB.id))]);
    assert.equal(result.status, 'rejected');
    assert.equal((await env.db.one('SELECT sync_status FROM sync_records WHERE record_id = $1', [result.id])).sync_status, 'rejected');
  });

  await t.test('concurrent edits to different fields are merged', async () => {
    const patient = childRecord(clinicA.id);
    const [created] = await nurseA.push([create('patients', patient)]);
    const base = created.record.version;
    await nurseA.push([update('patients', { ...patient, address: 'Ward 2' }, base, ['address'])]);
    const [second] = await nurseA2.push([update('patients', { ...patient, full_name: 'Renamed Child' }, base, ['full_name'])]);
    assert.equal(second.status, 'merged');
    assert.equal(second.record.address, 'Ward 2');
    assert.equal(second.record.full_name, 'Renamed Child');
    assert.equal(second.record.version, base + 2);
  });

  await t.test('non-critical field changed at two nodes: last received wins and is logged', async () => {
    const patient = childRecord(clinicA.id, { address: 'Old address' });
    const [created] = await nurseA.push([create('patients', patient)]);
    await nurseA.push([update('patients', { ...patient, address: 'Address 1' }, created.record.version, ['address'])]);
    const [second] = await nurseA2.push([update('patients', { ...patient, address: 'Address 2' }, created.record.version, ['address'])]);
    assert.equal(second.record.address, 'Address 2');
    assert.equal(second.conflict_status, 'auto_resolved');
    const logged = await env.db.one("SELECT * FROM conflicts WHERE record_id = $1 AND status = 'auto_resolved'", [patient.id]);
    assert.equal(logged.server_value, 'Address 1');
  });

  await t.test('critical field changed at two nodes: server value kept, flagged for review', async () => {
    const patient = childRecord(clinicA.id);
    const [created] = await nurseA.push([create('patients', patient)]);
    await nurseA.push([update('patients', { ...patient, dob: '2026-01-11' }, created.record.version, ['dob'])]);
    const [second] = await nurseA2.push([update('patients', { ...patient, dob: '2026-01-12' }, created.record.version, ['dob'])]);
    assert.equal(second.status, 'conflict');
    assert.equal(second.conflict_status, 'pending_review');
    assert.equal(second.record.dob, '2026-01-11');

    const { conflicts } = await admin.get('/admin/conflicts');
    const conflict = conflicts.find((c) => c.record_id === patient.id && c.field === 'dob');
    assert.equal(conflict.local_value, '2026-01-12');
    assert.equal((await admin.send('POST', `/admin/conflicts/${conflict.id}/resolve`, { action: 'use_local' })).status, 200);
    assert.equal((await env.db.one('SELECT dob FROM patients WHERE id = $1', [patient.id])).dob, '2026-01-12');
  });

  await t.test('vaccination records are append-only but can be voided', async () => {
    const patient = childRecord(clinicA.id);
    const record = dose(patient.id, clinicA.id, 'BCG-1', '2026-01-10');
    await nurseA.push([create('patients', patient), create('vaccination_records', record)]);
    const [edit] = await nurseA.push([update('vaccination_records', { ...record, date_administered: '2026-01-11' }, 1, ['date_administered'])]);
    assert.equal(edit.status, 'rejected');
    const [voided] = await nurseA.push([update('vaccination_records', { ...record, record_status: 'voided', void_reason: 'Wrong child' }, 1,
      ['record_status', 'void_reason'])]);
    assert.equal(voided.record.record_status, 'voided');
    assert.equal(voided.change_type, 'void');
  });

  await t.test('the same dose recorded at two clinics is kept twice and flagged', async () => {
    const patient = childRecord(clinicA.id);
    await nurseA.push([create('patients', patient), create('vaccination_records', dose(patient.id, clinicA.id, 'PENTA-1', '2026-02-21'))]);
    const [second] = await nurseB.push([create('vaccination_records', dose(patient.id, clinicB.id, 'PENTA-1', '2026-02-21'))]);
    assert.equal(second.status, 'flagged');
    assert.equal((await env.db.one('SELECT COUNT(*)::int AS n FROM vaccination_records WHERE patient_id = $1', [patient.id])).n, 2);
  });

  await t.test('a patient registered at two clinics is flagged and can be merged', async () => {
    const first = childRecord(clinicA.id, { full_name: 'Amina Yusuf', dob: '2026-03-03' });
    const second = childRecord(clinicB.id, { full_name: 'YUSUF Amina', dob: '2026-03-03' });
    await nurseA.push([create('patients', first)]);
    const [result] = await nurseB.push([create('patients', second)]);
    assert.equal(result.status, 'flagged');
    const bcg = dose(second.id, clinicB.id, 'BCG-1', '2026-03-03');
    await nurseB.push([create('vaccination_records', bcg)]);

    const { conflicts } = await admin.get('/admin/conflicts');
    const conflict = conflicts.find((c) => c.kind === 'possible_duplicate' && c.record_id === second.id);
    assert.equal((await admin.send('POST', `/admin/conflicts/${conflict.id}/resolve`, { action: 'merge', keep_id: first.id })).status, 200);
    assert.equal((await env.db.one('SELECT merged_into_id FROM patients WHERE id = $1', [second.id])).merged_into_id, first.id);
    assert.equal((await env.db.one('SELECT patient_id FROM vaccination_records WHERE id = $1', [bcg.id])).patient_id, first.id);
    assert.ok((await nurseA.pull(0)).changes.some((c) => c.record.id === bcg.id));
  });

  await t.test('a clinic that vaccinates a visiting patient receives later updates to that patient', async () => {
    const patient = childRecord(clinicA.id);
    const [created] = await nurseA.push([create('patients', patient)]);
    await nurseB.push([create('vaccination_records', dose(patient.id, clinicB.id, 'BCG-1', '2026-01-12'))]);
    const { last_seq: since } = await nurseB.pull(0);
    await nurseA.push([update('patients', { ...patient, address: 'Moved' }, created.record.version, ['address'])]);
    const { changes } = await nurseB.pull(since);
    assert.ok(changes.some((c) => c.record.id === patient.id && c.record.address === 'Moved'));
  });

  await t.test('pull is incremental and ordered by server sequence', async () => {
    const all = await nurseA.pull(0);
    assert.equal((await nurseA.pull(all.last_seq)).changes.length, 0);
    const seqs = all.changes.map((c) => c.record.server_seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  await t.test('administrators configure vaccines and settings; health workers cannot', async () => {
    assert.equal((await nurseA.send('PUT', '/admin/settings', { settings: { upcoming_window_days: 3 } })).status, 403);
    const res = await admin.send('PUT', '/admin/settings', { settings: { upcoming_window_days: 10, sms_enabled: false } });
    assert.equal(res.body.settings.upcoming_window_days, 10);
    assert.equal((await nurseA.get('/config')).settings.sms_enabled, false);
    assert.equal((await admin.send('PATCH', '/admin/vaccines/YF-1', { status: 'inactive' })).status, 200);
    assert.equal((await env.db.one("SELECT COUNT(*)::int AS n FROM vaccination_schedules WHERE vaccine_id = 'YF-1'")).n, 0);
    assert.equal((await admin.send('PATCH', '/admin/vaccines/YF-1', { status: 'active', recommended_age: 'nine months' })).status, 400);
    await admin.send('PATCH', '/admin/vaccines/YF-1', { status: 'active' });
    await admin.send('PUT', '/admin/settings', { settings: { upcoming_window_days: 7, sms_enabled: true } });
  });

  await t.test('reminders are sent once per dose and only with consent', async () => {
    const today = todayISO();
    const guardian = { id: randomUUID(), full_name: 'Hauwa Musa', phone: '08099990001', relationship: 'Mother',
      sms_consent: true, preferred_notification: 'sms', clinic_id: clinicA.id };
    const noConsent = { ...guardian, id: randomUUID(), sms_consent: false, phone: '08099990002' };
    const due = childRecord(clinicA.id, { dob: addDays(today, -42), registration_date: today, guardian_id: guardian.id });
    const silent = childRecord(clinicA.id, { dob: addDays(today, -42), registration_date: today, guardian_id: noConsent.id });
    await nurseA.push([create('guardians', guardian), create('guardians', noConsent), create('patients', due), create('patients', silent)]);

    const first = await runReminders(env.db, { today, sender: quietSender });
    const second = await runReminders(env.db, { today, sender: quietSender });
    assert.ok(first.sent > 0);
    assert.equal(second.sent, 0);
    const phones = (await env.db.query('SELECT DISTINCT phone FROM notifications')).map((r) => r.phone);
    assert.ok(phones.includes('08099990001'));
    assert.ok(!phones.includes('08099990002'));
  });

  await t.test('new users must change the temporary password; the old token stops working', async () => {
    const created = await admin.send('POST', '/admin/users', {
      full_name: 'New Nurse', username: 'newnurse', password: '1234567890', role: 'health_worker', clinic_id: clinicA.id,
    });
    assert.equal(created.status, 201);
    const fresh = await node(env, 'newnurse', '1234567890');
    assert.equal(fresh.user.must_change_password, true);
    assert.equal((await fresh.send('POST', '/auth/password', { current_password: '1234567890', new_password: '1234567890' })).status, 400);
    assert.equal((await fresh.send('POST', '/auth/password', { current_password: 'wrong', new_password: 'clinic-pass-1' })).status, 400);
    await new Promise((r) => setTimeout(r, 1100)); // token iat has 1-second resolution
    const changed = await fresh.send('POST', '/auth/password', { current_password: '1234567890', new_password: 'clinic-pass-1' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.must_change_password, false);
    assert.equal((await fresh.send('GET', '/config')).status, 401, 'token from before the change is rejected');
    const again = await node(env, 'newnurse', 'clinic-pass-1');
    assert.equal(again.user.must_change_password, false);
  });

  await t.test('an account is locked after repeated failed logins', async () => {
    await admin.send('POST', '/admin/users', {
      full_name: 'Lock Test', username: 'locktest', password: '1234567890', role: 'health_worker', clinic_id: clinicA.id,
    });
    const attempt = (password) => fetch(`${env.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'locktest', password }) }).then((r) => r.status);
    for (let i = 0; i < 4; i++) assert.equal(await attempt('wrong'), 401);
    assert.equal(await attempt('wrong'), 429);
    assert.equal(await attempt('1234567890'), 429, 'locked even with the right password');
    const user = await env.db.one("SELECT id FROM users WHERE username = 'locktest'");
    await admin.send('PATCH', `/admin/users/${user.id}`, { password: '1234567890' }); // a reset unlocks
    assert.equal(await attempt('1234567890'), 200);
  });

  await t.test('an inactive patient is not followed up and gets no reminders', async () => {
    const today = todayISO();
    const guardian = { id: randomUUID(), full_name: 'Zainab Ali', phone: '08099990003', relationship: 'Mother',
      sms_consent: true, preferred_notification: 'sms', clinic_id: clinicA.id };
    const patient = childRecord(clinicA.id, { dob: addDays(today, -42), registration_date: today, guardian_id: guardian.id });
    const [, created] = await nurseA.push([create('guardians', guardian), create('patients', patient)]);
    const [moved] = await nurseA.push([update('patients', { ...patient, status: 'deceased', status_date: today },
      created.record.version, ['status', 'status_date'])]);
    assert.equal(moved.status, 'applied');
    const statuses = (await env.db.query('SELECT DISTINCT status FROM vaccination_schedules WHERE patient_id = $1', [patient.id])).map((r) => r.status);
    assert.deepEqual(statuses, ['inactive']);
    await runReminders(env.db, { today, sender: quietSender });
    assert.equal((await env.db.one('SELECT COUNT(*)::int AS n FROM notifications WHERE patient_id = $1', [patient.id])).n, 0);
    const [bad] = await nurseA.push([update('patients', { ...patient, status: 'gone' }, moved.record.version, ['status'])]);
    assert.equal(bad.status, 'rejected');
  });

  await t.test('a dose given elsewhere is stored with its facility', async () => {
    const patient = childRecord(clinicA.id);
    const record = dose(patient.id, clinicA.id, 'BCG-1', '2026-01-12', { given_elsewhere: true, facility_name: 'General Hospital' });
    const [, result] = await nurseA.push([create('patients', patient), create('vaccination_records', record)]);
    assert.equal(result.record.given_elsewhere, true);
    assert.equal(result.record.facility_name, 'General Hospital');
  });

  await t.test('an administrator transfers a patient and the new clinic receives the full history', async () => {
    const guardian = { id: randomUUID(), full_name: 'Folake Ade', phone: '08099990004', relationship: 'Mother', sms_consent: false, clinic_id: clinicA.id };
    const patient = childRecord(clinicA.id, { guardian_id: guardian.id });
    const record = dose(patient.id, clinicA.id, 'BCG-1', '2026-01-10');
    await nurseA.push([create('guardians', guardian), create('patients', patient), create('vaccination_records', record)]);
    const since = (await nurseB.pull(0)).last_seq;
    assert.equal((await nurseA.send('POST', `/admin/patients/${patient.id}/transfer`, { clinic_id: clinicB.id })).status, 403);
    assert.equal((await admin.send('POST', `/admin/patients/${patient.id}/transfer`, { clinic_id: clinicB.id })).status, 200);
    const ids = (await nurseB.pull(since)).changes.map((c) => c.record.id);
    for (const id of [patient.id, guardian.id, record.id]) assert.ok(ids.includes(id));
  });

  await t.test('administrators add vaccines and edit users', async () => {
    const res = await admin.send('POST', '/admin/vaccines', {
      code: 'hpv', name: 'Human Papillomavirus', dose_number: 1, target: 'child', recommended_age: '9y',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.id, 'HPV-1');
    assert.ok((await nurseA.get('/config')).vaccines.some((v) => v.id === 'HPV-1'));
    assert.equal((await admin.send('POST', '/admin/vaccines', { code: 'HPV', name: 'x', dose_number: 1, target: 'child', recommended_age: '9y' })).status, 409);
    await admin.send('PATCH', '/admin/vaccines/HPV-1', { status: 'inactive' });

    const user = await env.db.one("SELECT id FROM users WHERE username = 'chew3'");
    assert.equal((await admin.send('PATCH', `/admin/users/${user.id}`, { full_name: 'Kemi A. Afolabi', email: 'kemi@example.org' })).status, 200);
    assert.equal((await env.db.one('SELECT full_name FROM users WHERE id = $1', [user.id])).full_name, 'Kemi A. Afolabi');
  });

  await t.test('searching other clinics is recorded in the audit trail', async () => {
    await nurseB.get('/patients/search?q=Bello');
    assert.ok(await env.db.one("SELECT 1 FROM audit_log WHERE action = 'patients.search_all_clinics' AND username = 'nurse2'"));
  });

  await t.test('the daily cron endpoint requires the cron secret', async () => {
    assert.equal((await fetch(`${env.base}/cron/daily`)).status, 401);
    const ok = await fetch(`${env.base}/cron/daily`, { headers: { authorization: 'Bearer cron-secret' } });
    assert.equal(ok.status, 200);
  });
});
