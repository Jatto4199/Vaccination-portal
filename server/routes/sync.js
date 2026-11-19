import { Router } from 'express';
import { pushChanges, pullChanges, getRecord, serverAudit } from '../sync.js';
import { getSettings } from '../db.js';

const MAX_BATCH = 200;

export function syncRoutes() {
  const router = Router();

  // Configuration every node needs to work offline: clinics, vaccines and settings.
  router.get('/config', async (req, res) => {
    res.json({
      clinics: await req.db.query('SELECT id, code, name, location, contact_phone, contact_email, node_id FROM clinics ORDER BY code'),
      vaccines: await req.db.query('SELECT * FROM vaccines ORDER BY sort_order'),
      settings: await getSettings(req.db),
      server_time: new Date().toISOString(),
    });
  });

  router.post('/sync/push', async (req, res) => {
    const changes = req.body?.changes;
    if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });
    if (changes.length > MAX_BATCH) return res.status(413).json({ error: `At most ${MAX_BATCH} changes per request` });
    const results = await pushChanges(req.db, { user: req.user, nodeId: req.nodeId }, changes);
    res.json({ results });
  });

  router.get('/sync/pull', async (req, res) => {
    const since = Number(req.query.since ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 500), 1000);
    if (!Number.isInteger(since) || since < 0) return res.status(400).json({ error: 'Invalid since' });
    res.json(await pullChanges(req.db, req.user, since, limit));
  });

  // Online search across all clinics, used before registering a patient who
  // may already be registered elsewhere (section 3.9: minimizing duplicates).
  router.get('/patients/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const like = `%${q}%`;
    const results = await req.db.query(`SELECT p.id, p.patient_number, p.full_name, p.type, p.dob, p.sex, p.address,
        c.name AS clinic_name, g.full_name AS guardian_name, g.phone AS guardian_phone
      FROM patients p
      LEFT JOIN clinics c ON c.id = p.clinic_id
      LEFT JOIN guardians g ON g.id = p.guardian_id
      WHERE p.merged_into_id IS NULL
        AND (p.full_name ILIKE $1 OR p.patient_number ILIKE $1 OR g.phone ILIKE $1 OR g.full_name ILIKE $1)
      ORDER BY p.full_name LIMIT 20`, [like]);
    // Searching other clinics' records is logged in the audit trail.
    await req.db.tx((tx) => serverAudit(tx, {
      user: req.user, action: 'patients.search_all_clinics', nodeId: req.nodeId, detail: { query: q, results: results.length },
    }));
    res.json({ results });
  });

  // A patient from another clinic, with guardian and vaccination history, so a
  // visiting patient can be served offline afterwards.
  router.get('/patients/:id/bundle', async (req, res) => {
    const patient = await getRecord(req.db, 'patients', req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    const guardian = patient.guardian_id ? await getRecord(req.db, 'guardians', patient.guardian_id) : null;
    const records = await req.db.query('SELECT * FROM vaccination_records WHERE patient_id = $1', [patient.id]);
    await req.db.tx((tx) => serverAudit(tx, {
      user: req.user, action: 'patients.downloaded', entity: 'patients', entityId: patient.id, nodeId: req.nodeId,
      detail: { clinic_id: patient.clinic_id },
    }));
    res.json({ patient, guardian, records });
  });

  return router;
}
