// Database maintenance commands. Uses DATABASE_URL when set (e.g. a Neon
// database for Vercel), otherwise the local embedded database.
//
//   npm run db:seed      add demo clinics, accounts and patients (only if no users exist)
//   npm run db:reset     DELETE ALL DATA and start again with demo data
//   npm run db:refresh   regenerate every stored vaccination schedule
import { openDatabase } from './db.js';
import { seedDemoData } from './seed.js';
import { regenerateSchedules } from './schedules.js';
import { LOCAL_DATA_DIR } from './runtime.js';

const TABLES = ['notifications', 'conflicts', 'record_versions', 'sync_records', 'vaccination_schedules', 'audit_log',
  'vaccination_records', 'patients', 'guardians', 'users', 'clinics', 'vaccines', 'settings', 'counters'];

const command = process.argv[2];
const target = process.env.DATABASE_URL ? 'the database in DATABASE_URL' : `the local database (${LOCAL_DATA_DIR})`;
const log = (m) => console.log(m);

if (command === 'reset') {
  if (!process.argv.includes('--yes')) {
    console.error(`This deletes ALL data in ${target}. Run again with --yes to confirm.`);
    process.exit(1);
  }
  const db = await openDatabase({ dataDir: LOCAL_DATA_DIR });
  await db.exec(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
  await db.close();
  log(`Deleted all tables in ${target}.`);
}

if (command === 'reset' || command === 'seed') {
  const db = await openDatabase({ dataDir: LOCAL_DATA_DIR });
  const seeded = await seedDemoData(db, { log });
  log(seeded ? 'Demo data created.' : 'Users already exist; nothing was added. Use db:reset to start again.');
  await db.close();
} else if (command === 'refresh') {
  const db = await openDatabase({ dataDir: LOCAL_DATA_DIR });
  log(`Regenerated schedules for ${await db.tx((q) => regenerateSchedules(q))} patients.`);
  await db.close();
} else if (command !== 'reset') {
  console.error('Usage: node src/cli.js <seed|reset --yes|refresh>');
  process.exit(1);
}
