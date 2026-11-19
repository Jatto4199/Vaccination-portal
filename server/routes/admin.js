// Administration (thesis section 3.15.2): users, clinics, system configuration
// (vaccines), synchronization settings, conflict review, audit trail, reminders.
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../shared/index.js';
import { hashPassword, publicUser } from '../auth.js';
import { getSettings, nowISO } from '../db.js';
import { serverAudit, serverUpdate, getRecord } from '../sync.js';
import { regenerateSchedules } from '../schedules.js';
import { runReminders } from '../reminders.js';

const ROLES = ['health_worker', 'admin'];
const PERIOD = /^\d+[dwmy]$/;
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export function adminRoutes({ sender }) {
  const router = Router();
  const audit = (q, req, action, entity, entityId, detail) =>
    serverAudit(q, { user: req.user, action, entity, entityId, detail, nodeId: req.nodeId });

  // ---- Users ----
  router.get('/users', async (req, res) => {
    const users = await req.db.query(`SELECT u.*, c.name AS clinic_name FROM users u
      LEFT JOIN clinics c ON c.id = u.clinic_id ORDER BY u.full_name`);
    res.json({ users: users.map((u) => ({ ...publicUser(u), account_status: u.account_status, clinic_name: u.clinic_name, date_created: u.date_created })) });
  });

  router.post('/users', async (req, res) => {
    const { full_name, username, email, password, role, clinic_id } = req.body ?? {};
    const login = username?.trim().toLowerCase();
    if (!full_name?.trim() || !login) throw badRequest('Name and username are required');
    if (!/^[a-z0-9._-]{3,30}$/.test(login)) throw badRequest('Username: 3-30 letters, digits, dots, dashes or underscores');
    if (email && !/^\S+@\S+\.\S+$/.test(email)) throw badRequest('Invalid email address');
    if (!password || password.length < 8) throw badRequest('Password must be at least 8 characters');
    if (!ROLES.includes(role)) throw badRequest('Invalid role');
    if (role === 'health_worker' && !clinic_id) throw badRequest('Health workers must belong to a clinic');
    if (await req.db.one('SELECT 1 FROM users WHERE username = $1 OR (email IS NOT NULL AND lower(email) = lower($2))', [login, email ?? ''])) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    const id = randomUUID();
    await req.db.tx(async (q) => {
      // The user must choose their own password at first login.
      await q.query(`INSERT INTO users (id, full_name, username, email, password_hash, role, clinic_id, must_change_password)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)`, [id, full_name.trim(), login, email?.trim() || null, hashPassword(password), role, clinic_id || null]);
      await audit(q, req, 'admin.user_created', 'users', id, { username: login, role });
    });
    res.status(201).json({ id });
  });

  router.patch('/users/:id', async (req, res) => {
    const user = await req.db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { account_status: status, role, clinic_id, password, full_name: fullName, email } = req.body ?? {};
    if (user.id === req.user.id && (status === 'disabled' || (role && role !== 'admin'))) {
      throw badRequest('You cannot disable or demote your own account');
    }
    if (role && !ROLES.includes(role)) throw badRequest('Invalid role');
    if (status && !['active', 'disabled'].includes(status)) throw badRequest('Invalid status');
    if (password !== undefined && password.length < 8) throw badRequest('Password must be at least 8 characters');
    if (fullName !== undefined && !fullName.trim()) throw badRequest('Name is required');
    if (email && !/^\S+@\S+\.\S+$/.test(email)) throw badRequest('Invalid email address');
    if (email && await req.db.one('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id != $2', [email, user.id])) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    const next = {
      full_name: fullName !== undefined ? fullName.trim() : user.full_name,
      email: email !== undefined ? email.trim() || null : user.email,
      account_status: status ?? user.account_status,
      role: role ?? user.role,
      clinic_id: clinic_id !== undefined ? clinic_id || null : user.clinic_id,
    };
    if (next.role === 'health_worker' && !next.clinic_id) throw badRequest('Health workers must belong to a clinic');
    await req.db.tx(async (q) => {
      await q.query(`UPDATE users SET full_name = $1, email = $2, account_status = $3, role = $4, clinic_id = $5 WHERE id = $6`,
        [next.full_name, next.email, next.account_status, next.role, next.clinic_id, user.id]);
      if (password) {
        // A reset password is temporary: the user must change it at next login,
        // and logins made with the old password stop working.
        await q.query(`UPDATE users SET password_hash = $1, must_change_password = true, password_changed_at = $2,
          failed_logins = 0, locked_until = NULL WHERE id = $3`, [hashPassword(password), nowISO(), user.id]);
      }
      await audit(q, req, 'admin.user_updated', 'users', user.id, {
        full_name: fullName, email, account_status: status, role, clinic_id, password_reset: Boolean(password),
      });
    });
    res.json({ ok: true });
  });

  // ---- Clinics (nodes) ----
  router.get('/clinics', async (req, res) => {
    res.json({ clinics: await req.db.query(`SELECT c.*,
      (SELECT COUNT(*)::int FROM patients p WHERE p.clinic_id = c.id AND p.merged_into_id IS NULL) AS patients,
      (SELECT COUNT(*)::int FROM users u WHERE u.clinic_id = c.id AND u.account_status = 'active') AS staff
      FROM clinics c ORDER BY c.code`) });
  });

  router.post('/clinics', async (req, res) => {
    const { name, location, contact_phone, contact_email } = req.body ?? {};
    const code = req.body?.code?.trim().toUpperCase();
    if (!code || !name?.trim()) throw badRequest('Code and name are required');
    if (!/^[A-Z0-9]{2,10}$/.test(code)) throw badRequest('Code must be 2-10 letters or digits');
    if (await req.db.one('SELECT 1 FROM clinics WHERE code = $1', [code])) return res.status(409).json({ error: 'Clinic code already exists' });
    const id = randomUUID();
    await req.db.tx(async (q) => {
      await q.query(`INSERT INTO clinics (id, code, name, location, contact_phone, contact_email, node_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, code, name.trim(), location || null, contact_phone || null, contact_email || null, `NODE-${code}`]);
      await audit(q, req, 'admin.clinic_created', 'clinics', id, { code, name });
    });
    res.status(201).json({ id });
  });

  router.patch('/clinics/:id', async (req, res) => {
    const clinic = await req.db.one('SELECT * FROM clinics WHERE id = $1', [req.params.id]);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
    const fields = ['name', 'location', 'contact_phone', 'contact_email'];
    const next = Object.fromEntries(fields.map((f) => [f, req.body?.[f] !== undefined ? req.body[f] || null : clinic[f]]));
    if (!next.name) throw badRequest('Name is required');
    await req.db.tx(async (q) => {
      await q.query('UPDATE clinics SET name = $1, location = $2, contact_phone = $3, contact_email = $4 WHERE id = $5',
        [next.name, next.location, next.contact_phone, next.contact_email, clinic.id]);
      await audit(q, req, 'admin.clinic_updated', 'clinics', clinic.id, next);
    });
    res.json({ ok: true });
  });

  // ---- System configuration: vaccines ----
  router.get('/vaccines', async (req, res) => {
    res.json({ vaccines: await req.db.query('SELECT * FROM vaccines ORDER BY sort_order') });
  });

  router.patch('/vaccines/:id', async (req, res) => {
    const vaccine = await req.db.one('SELECT * FROM vaccines WHERE id = $1', [req.params.id]);
    if (!vaccine) return res.status(404).json({ error: 'Vaccine not found' });
    const fields = ['name', 'recommended_age', 'recommended_interval', 'min_age', 'max_age', 'status'];
    const next = Object.fromEntries(fields.map((f) => [f, req.body?.[f] !== undefined ? (req.body[f] || null) : vaccine[f]]));
    for (const f of ['recommended_age', 'recommended_interval', 'min_age', 'max_age']) {
      if (next[f] && !PERIOD.test(next[f])) throw badRequest(`${f} must look like 6w, 9m, 14d or 1y`);
    }
    if (!['active', 'inactive'].includes(next.status)) throw badRequest('Invalid status');
    if (vaccine.target === 'child' && !next.recommended_age) throw badRequest('Child vaccines need a recommended age');
    await req.db.tx(async (q) => {
      await q.query(`UPDATE vaccines SET name = $1, recommended_age = $2, recommended_interval = $3, min_age = $4, max_age = $5,
        status = $6 WHERE id = $7`, [next.name ?? vaccine.name, next.recommended_age, next.recommended_interval, next.min_age, next.max_age, next.status, vaccine.id]);
      await regenerateSchedules(q);
      await audit(q, req, 'admin.vaccine_updated', 'vaccines', vaccine.id, next);
    });
    res.json({ ok: true });
  });

  router.post('/vaccines', async (req, res) => {
    const body = req.body ?? {};
    const code = String(body.code ?? '').trim().toUpperCase();
    const doseNumber = Number(body.dose_number);
    const target = body.target;
    if (!/^[A-Z0-9]{2,10}$/.test(code)) throw badRequest('Code must be 2-10 letters or digits, e.g. HPV');
    if (!body.name?.trim()) throw badRequest('Name is required');
    if (!Number.isInteger(doseNumber) || doseNumber < 0 || doseNumber > 10) throw badRequest('Dose number must be 0-10');
    if (!['child', 'mother'].includes(target)) throw badRequest('Target must be child or mother');
    const periods = Object.fromEntries(['recommended_age', 'recommended_interval', 'min_age', 'max_age']
      .map((f) => [f, String(body[f] ?? '').trim() || null]));
    for (const [f, v] of Object.entries(periods)) if (v && !PERIOD.test(v)) throw badRequest(`${f} must look like 6w, 9m, 14d or 1y`);
    if (target === 'child' && !periods.recommended_age) throw badRequest('Child vaccines need a recommended age');
    const id = `${code}-${doseNumber}`;
    if (await req.db.one('SELECT 1 FROM vaccines WHERE id = $1 OR (code = $2 AND dose_number = $3 AND target = $4)',
      [id, code, doseNumber, target])) {
      return res.status(409).json({ error: `${code} dose ${doseNumber} already exists` });
    }
    await req.db.tx(async (q) => {
      const { n } = await q.one('SELECT COALESCE(MAX(sort_order), 0)::int + 1 AS n FROM vaccines');
      await q.query(`INSERT INTO vaccines (id, code, name, dose_number, target, recommended_age, recommended_interval,
        min_age, max_age, sort_order, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')`, [
        id, code, body.name.trim(), doseNumber, target, periods.recommended_age, periods.recommended_interval,
        periods.min_age ?? periods.recommended_age, periods.max_age, n]);
      await regenerateSchedules(q);
      await audit(q, req, 'admin.vaccine_created', 'vaccines', id, { code, dose_number: doseNumber, target });
    });
    res.status(201).json({ id });
  });

  // ---- Patient transfer between clinics ----
  // The patient's guardian and vaccination records are re-saved (new version)
  // so the receiving clinic's devices pull them at their next sync.
  router.post('/patients/:id/transfer', async (req, res) => {
    const patient = await getRecord(req.db, 'patients', req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    const clinic = await req.db.one('SELECT * FROM clinics WHERE id = $1', [req.body?.clinic_id]);
    if (!clinic) throw badRequest('Choose the receiving clinic');
    if (clinic.id === patient.clinic_id) throw badRequest('The patient is already registered at this clinic');
    const ctx = { user: req.user, nodeId: req.nodeId };
    await req.db.tx(async (q) => {
      await serverUpdate(q, ctx, 'patients', patient.id, { clinic_id: clinic.id });
      if (patient.guardian_id && await getRecord(q, 'guardians', patient.guardian_id)) {
        await serverUpdate(q, ctx, 'guardians', patient.guardian_id, {});
      }
      const records = await q.query('SELECT id FROM vaccination_records WHERE patient_id = $1', [patient.id]);
      for (const r of records) await serverUpdate(q, ctx, 'vaccination_records', r.id, {});
      await regenerateSchedules(q, [patient.id]);
      await audit(q, req, 'admin.patient_transferred', 'patients', patient.id, { from: patient.clinic_id, to: clinic.id });
    });
    res.json({ ok: true });
  });

  // ---- Synchronization and reminder settings ----
  router.get('/settings', async (req, res) => res.json({ settings: await getSettings(req.db) }));

  router.put('/settings', async (req, res) => {
    const input = req.body?.settings ?? {};
    const updates = {};
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
      if (input[key] === undefined) continue;
      if (typeof fallback === 'boolean') updates[key] = Boolean(input[key]);
      else {
        const n = Number(input[key]);
        if (!Number.isInteger(n) || n < 0 || n > 100000) throw badRequest(`${key} must be a whole number`);
        updates[key] = n;
      }
    }
    if (updates.sync_interval_seconds !== undefined && updates.sync_interval_seconds < 15) throw badRequest('Sync interval must be at least 15 seconds');
    await req.db.tx(async (q) => {
      for (const [key, value] of Object.entries(updates)) {
        await q.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
      }
      if ('upcoming_window_days' in updates || 'overdue_grace_days' in updates) await regenerateSchedules(q);
      await audit(q, req, 'admin.settings_updated', 'settings', null, updates);
    });
    res.json({ settings: await getSettings(req.db) });
  });

  // ---- Conflicts ----
  router.get('/conflicts', async (req, res) => {
    const status = req.query.status ?? 'pending';
    const conflicts = await req.db.query(`SELECT cf.*, u.full_name AS user_name FROM conflicts cf
      LEFT JOIN users u ON u.id = cf.user_id WHERE cf.status = $1 ORDER BY cf.created_at DESC LIMIT 200`, [status]);
    for (const cf of conflicts) {
      cf.record = await getRecord(req.db, cf.table_name, cf.record_id);
      cf.other_record = cf.other_record_id ? await getRecord(req.db, cf.table_name, cf.other_record_id) : null;
    }
    res.json({ conflicts });
  });

  router.post('/conflicts/:id/resolve', async (req, res) => {
    const conflict = await req.db.one('SELECT * FROM conflicts WHERE id = $1', [req.params.id]);
    if (!conflict) return res.status(404).json({ error: 'Conflict not found' });
    if (conflict.status === 'resolved') return res.status(409).json({ error: 'Already resolved' });
    const { action, keep_id: keepId, reason } = req.body ?? {};
    const ctx = { user: req.user, nodeId: req.nodeId };
    const valid = {
      field: ['keep_server', 'use_local', 'acknowledge'],
      duplicate_dose: ['keep_both', 'void_record', 'void_other'],
      possible_duplicate: ['not_duplicate', 'merge'],
    }[conflict.kind];
    if (!valid.includes(action)) throw badRequest(`Action must be one of ${valid.join(', ')}`);

    await req.db.tx(async (q) => {
      const affected = [];
      if (action === 'use_local') {
        const row = await serverUpdate(q, ctx, conflict.table_name, conflict.record_id, { [conflict.field]: conflict.local_value });
        if (conflict.table_name === 'patients') affected.push(row.id);
      } else if (action === 'void_record' || action === 'void_other') {
        const id = action === 'void_record' ? conflict.record_id : conflict.other_record_id;
        const row = await serverUpdate(q, ctx, 'vaccination_records', id, {
          record_status: 'voided', void_reason: reason || 'Duplicate dose record', voided_by: req.user.id, voided_at: nowISO(),
        });
        affected.push(row.patient_id);
      } else if (action === 'merge') {
        if (![conflict.record_id, conflict.other_record_id].includes(keepId)) throw badRequest('keep_id must be one of the two patients');
        const removeId = keepId === conflict.record_id ? conflict.other_record_id : conflict.record_id;
        // Vaccination records move to the surviving patient; the duplicate is
        // kept (marked as merged) so the change stays traceable.
        const records = await q.query('SELECT id FROM vaccination_records WHERE patient_id = $1', [removeId]);
        for (const r of records) await serverUpdate(q, ctx, 'vaccination_records', r.id, { patient_id: keepId });
        await serverUpdate(q, ctx, 'patients', removeId, { merged_into_id: keepId });
        affected.push(keepId, removeId);
      }
      if (affected.length) await regenerateSchedules(q, affected);
      await q.query('UPDATE conflicts SET status = $1, resolved_by = $2, resolved_at = $3, resolution = $4 WHERE id = $5',
        ['resolved', req.user.id, nowISO(), action, conflict.id]);
      await audit(q, req, 'admin.conflict_resolved', conflict.table_name, conflict.record_id, { kind: conflict.kind, action });
    });
    res.json({ ok: true });
  });

  // ---- Synchronization records ----
  router.get('/sync-records', async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    res.json({ records: await req.db.query(`SELECT s.id, s.table_name, s.record_id, s.node_id, s.change_type, s.version_number,
        s.timestamp, s.sync_status, s.conflict_status, s.error, c.code AS clinic_code, u.username
      FROM sync_records s LEFT JOIN clinics c ON c.id = s.clinic_id LEFT JOIN users u ON u.id = s.user_id
      WHERE s.table_name != 'audit_log'
      ORDER BY s.timestamp DESC LIMIT $1`, [limit]) });
  });

  // ---- Audit trail ----
  router.get('/audit', async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    res.json({ entries: await req.db.query('SELECT * FROM audit_log ORDER BY at DESC LIMIT $1', [limit]) });
  });

  // ---- Reminders ----
  router.get('/notifications', async (req, res) => {
    res.json({ notifications: await req.db.query(`SELECT n.*, p.full_name AS patient_name FROM notifications n
      LEFT JOIN patients p ON p.id = n.patient_id ORDER BY n.created_at DESC LIMIT 200`) });
  });

  router.post('/reminders/run', async (req, res) => {
    const result = await runReminders(req.db, { sender });
    await req.db.tx((q) => audit(q, req, 'admin.reminders_run', null, null, result));
    res.json(result);
  });

  return router;
}
