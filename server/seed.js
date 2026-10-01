// Demo data for development and project demonstration. All people, phone
// numbers and clinics are fictional. Vaccination histories are simulated
// relative to today so the dashboard always shows realistic due, upcoming and
// overdue vaccinations.

import { randomUUID } from 'node:crypto';
import { addDays, computeSchedule, todayISO, STATUS, DEFAULT_PASSWORD } from '../shared/index.js';
import { hashPassword } from './auth.js';
import { nowISO } from './db.js';
import { serverCreate, serverAudit, flagDuplicates } from './sync.js';
import { regenerateSchedules } from './schedules.js';

const CLINICS = [
  { code: 'CLN01', name: 'Iloro Primary Health Centre', location: 'Iloro Ward' },
  { code: 'CLN02', name: 'Oke-Ode Primary Health Centre', location: 'Oke-Ode Ward' },
  { code: 'CLN03', name: 'Ajasse Primary Health Centre', location: 'Ajasse Ward' },
];

const STAFF = [
  ['nurse1', 'Aisha Abdullahi', 'CLN01'], ['chew1', 'Tunde Olawale', 'CLN01'],
  ['nurse2', 'Bola Adeyemi', 'CLN02'], ['chew2', 'Ibrahim Musa', 'CLN02'],
  ['nurse3', 'Chioma Eze', 'CLN03'], ['chew3', 'Kemi Afolabi', 'CLN03'],
];

const MOTHER_NAMES = ['Hauwa', 'Fatima', 'Zainab', 'Aminat', 'Folake', 'Bisola', 'Ngozi', 'Adaeze', 'Halima', 'Yetunde',
  'Rukayat', 'Funmilayo', 'Blessing', 'Grace', 'Maryam', 'Kafayat', 'Esther', 'Titilayo', 'Hadiza', 'Chinwe', 'Mojisola',
  'Sekinat', 'Ifeoma', 'Lami'];
const CHILD_NAMES = {
  F: ['Aisha', 'Fatimah', 'Morenike', 'Simisola', 'Chiamaka', 'Khadija', 'Oluwaseun', 'Ruqayyah', 'Adunni', 'Precious',
    'Ireoluwa', 'Nafisa', 'Damilola', 'Ebube', 'Zahra'],
  M: ['Musa', 'Ahmed', 'Oluwatobi', 'Chukwuemeka', 'Ibrahim', 'Ayomide', 'Usman', 'Femi', 'Kelechi', 'Abdullahi',
    'Tobiloba', 'Sadiq', 'Emeka', 'Yusuf', 'Daniel'],
};
const SURNAMES = ['Bello', 'Okafor', 'Adebayo', 'Lawal', 'Yusuf', 'Olaniyan', 'Ibrahim', 'Eze', 'Salami', 'Abubakar',
  'Ogunleye', 'Nwosu', 'Aliyu', 'Oyelaran', 'Danjuma', 'Akande', 'Uche', 'Garba', 'Ajayi', 'Suleiman'];
const STREETS = ['Market Road', 'Oja Oba Street', 'Church Street', 'Mosque Road', 'Station Road', 'School Road', 'Palace Way'];

// Small deterministic random generator, so every seed produces the same data.
function random(seed) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

// Simulates a child's attendance: doses due on the same day are given at the
// same visit, `delayFor` decides how late each visit is, and a defaulter
// stops attending after `maxVisits` visits.
function simulateHistory(patient, vaccines, today, { delayFor, maxVisits, firstVisit }) {
  const records = [];
  const visits = new Map();
  const skipped = new Set();
  for (let guard = 0; guard < 60; guard++) {
    const next = computeSchedule(patient, records, vaccines, { today })
      .filter((i) => [STATUS.OVERDUE, STATUS.DUE].includes(i.status) && !skipped.has(i.vaccine_id))
      .sort((a, b) => a.expected_due_date.localeCompare(b.expected_due_date))[0];
    if (!next) break;
    let date = visits.get(next.expected_due_date);
    if (!date) {
      if (visits.size >= maxVisits) break;
      const base = next.expected_due_date < firstVisit ? firstVisit : next.expected_due_date;
      date = addDays(base, delayFor(visits.size));
      visits.set(next.expected_due_date, date);
    }
    // Only visits before today: doses due today are left for the clinic to give.
    if (date >= today || date < (next.earliest_date ?? date)) {
      skipped.add(next.vaccine_id);
      continue;
    }
    records.push({ id: randomUUID(), patient_id: patient.id, vaccine_id: next.vaccine_id, dose_number: next.dose_number,
      date_administered: date, record_status: 'valid' });
  }
  return records;
}

export async function seedDemoData(db, {
  today = todayISO(),
  adminPassword = process.env.SEED_ADMIN_PASSWORD || DEFAULT_PASSWORD,
  staffPassword = process.env.SEED_STAFF_PASSWORD || DEFAULT_PASSWORD,
  log = () => {},
} = {}) {
  if ((await db.one('SELECT COUNT(*)::int AS n FROM users')).n > 0) return false;
  const rnd = random(20260924);
  const vaccines = await db.query("SELECT * FROM vaccines WHERE status = 'active'");
  const ctx = { nodeId: 'seed', user: null };

  // Clinics and accounts
  const clinics = {};
  await db.tx(async (q) => {
    for (const c of CLINICS) {
      const id = randomUUID();
      clinics[c.code] = { id, ...c };
      await q.query(`INSERT INTO clinics (id, code, name, location, contact_phone, node_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, c.code, c.name, c.location, `0800000${c.code.slice(-2)}00`, `NODE-${c.code}`]);
    }
    const adminId = randomUUID();
    ctx.user = { id: adminId, username: 'admin', clinic_id: null };
    await q.query(`INSERT INTO users (id, full_name, username, email, password_hash, role, clinic_id)
      VALUES ($1, $2, $3, $4, $5, 'admin', NULL)`, [adminId, 'System Administrator', 'admin', 'admin@example.org', hashPassword(adminPassword)]);
    for (const [username, name, code] of STAFF) {
      const id = randomUUID();
      clinics[code].staff = [...(clinics[code].staff ?? []), { id, name }];
      await q.query(`INSERT INTO users (id, full_name, username, email, password_hash, role, clinic_id)
        VALUES ($1, $2, $3, $4, $5, 'health_worker', $6)`, [id, name, username, `${username}@example.org`, hashPassword(staffPassword), clinics[code].id]);
    }
  });
  log('Created 3 clinics and 7 user accounts');

  // Families, patients and vaccination histories
  let phoneCounter = 0;
  let patientCounter = 0;
  let recordCount = 0;
  const firstChild = {};
  for (const clinic of Object.values(clinics)) {
    let number = 0;
    const nextNumber = () => `${clinic.code}-SEED-${String(++number).padStart(4, '0')}`;
    await db.tx(async (q) => {
      for (let f = 0; f < 12; f++) {
        const surname = rnd.pick(SURNAMES);
        const relationship = rnd.chance(0.85) ? 'Mother' : rnd.pick(['Father', 'Grandmother']);
        const guardianName = relationship === 'Father' ? `${rnd.pick(['Musa', 'Segun', 'Chinedu', 'Abdul'])} ${surname}`
          : `${rnd.pick(MOTHER_NAMES)} ${surname}`;
        const address = `${rnd.int(1, 60)} ${rnd.pick(STREETS)}, ${clinic.location.replace(' Ward', '')}`;
        const guardian = await serverCreate(q, ctx, 'guardians', {
          full_name: guardianName, relationship, phone: `0800${String(++phoneCounter).padStart(7, '0')}`, address,
          id_number: rnd.chance(0.5) ? String(rnd.int(10000000000, 99999999999)) : null,
          preferred_notification: rnd.chance(0.8) ? 'sms' : 'call', sms_consent: rnd.chance(0.8), clinic_id: clinic.id,
        });
        const staff = () => rnd.pick(clinic.staff);
        const writeRecords = async (patient, records) => {
          for (const r of records) {
            const by = staff();
            await serverCreate(q, ctx, 'vaccination_records', {
              ...r, administered_by: by.id, administered_by_name: by.name, clinic_id: clinic.id,
              batch_number: `BN${rnd.int(10000, 99999)}`,
            });
          }
          recordCount += records.length;
        };

        // Mother registered for maternal Td at antenatal care.
        if (relationship === 'Mother' && rnd.chance(0.6)) {
          const registration = addDays(today, -rnd.int(0, 330));
          const mother = {
            id: randomUUID(), patient_number: nextNumber(), type: 'mother', full_name: guardianName,
            dob: addDays(today, -rnd.int(18 * 365, 38 * 365)), address, guardian_id: guardian.id, clinic_id: clinic.id,
            registration_date: registration,
          };
          await serverCreate(q, ctx, 'patients', mother);
          await q.query('UPDATE guardians SET patient_id = $1 WHERE id = $2', [mother.id, guardian.id]);
          await writeRecords(mother, simulateHistory(mother, vaccines, today, {
            firstVisit: registration, maxVisits: rnd.int(1, 5), delayFor: () => rnd.int(0, 14),
          }));
          patientCounter++;
        }

        // One or two children per family. The first families of each clinic
        // have babies whose next dose falls today or in the next few days
        // (6 weeks, 10 weeks - 2 days, 14 weeks - 4 days, 9 months - 3 days old),
        // so every clinic has due and upcoming vaccinations to show.
        const planned = [42, 68, 94, 271][f];
        const children = planned ? 1 : rnd.chance(0.3) ? 2 : 1;
        for (let k = 0; k < children; k++) {
          const sex = rnd.chance(0.5) ? 'F' : 'M';
          const ageDays = planned ?? (k === 0 ? rnd.int(1, 540) : rnd.int(500, 720));
          const dob = addDays(today, -ageDays);
          // Most babies are registered in their first two weeks; some present late.
          const late = !planned && rnd.chance(0.2);
          const registration = addDays(dob, planned ? 0 : Math.min(ageDays, late ? rnd.int(60, 180) : rnd.int(0, 14)));
          const child = {
            id: randomUUID(), patient_number: nextNumber(), type: 'child', full_name: `${rnd.pick(CHILD_NAMES[sex])} ${surname}`,
            dob, sex, address, guardian_id: guardian.id, clinic_id: clinic.id, registration_date: registration,
          };
          await serverCreate(q, ctx, 'patients', child);
          firstChild[clinic.code] ??= child;
          const profile = rnd.next();
          await writeRecords(child, simulateHistory(child, vaccines, today, {
            firstVisit: registration,
            // 55% on time, 30% often late, 15% stop attending (defaulters).
            maxVisits: planned || profile < 0.85 ? 99 : rnd.int(1, 3),
            delayFor: () => (planned ? 0 : profile < 0.55 ? rnd.int(0, 4) : rnd.int(5, 35)),
          }));
          patientCounter++;
        }
      }
    });
  }

  // A child registered at two clinics, so the conflict review queue has an example.
  const original = firstChild.CLN01;
  await db.tx(async (q) => {
    const guardian = await serverCreate(q, ctx, 'guardians', {
      full_name: 'Guardian of ' + original.full_name, relationship: 'Mother', phone: `0800${String(++phoneCounter).padStart(7, '0')}`,
      preferred_notification: 'sms', sms_consent: false, clinic_id: clinics.CLN02.id,
    });
    const duplicate = await serverCreate(q, { ...ctx, user: ctx.user }, 'patients', {
      ...original, id: randomUUID(), patient_number: `CLN02-SEED-9999`, full_name: original.full_name.split(' ').reverse().join(' '),
      guardian_id: guardian.id, clinic_id: clinics.CLN02.id, registration_date: today,
    });
    await flagDuplicates(q, 'patients', duplicate, ctx);
    await regenerateSchedules(q, null, today);
    await serverAudit(q, { user: ctx.user, action: 'seed.demo_data', detail: { patients: patientCounter + 1, records: recordCount }, nodeId: 'seed' });
  });
  log(`Created ${patientCounter + 1} patients and ${recordCount} vaccination records (seeded ${nowISO()})`);
  return true;
}
