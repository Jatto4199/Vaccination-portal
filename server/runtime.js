// Shared startup for the local server, the Vercel function and the CLI.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './db.js';
import { seedDemoData } from './seed.js';

const here = dirname(fileURLToPath(import.meta.url));
export const LOCAL_DATA_DIR = join(here, 'data/pgdata');

export function config() {
  const onVercel = Boolean(process.env.VERCEL);
  return {
    databaseUrl: process.env.DATABASE_URL || null,
    jwtSecret: process.env.JWT_SECRET || null,
    cronSecret: process.env.CRON_SECRET || null,
    // Demo data is added automatically to the local embedded database, and
    // to a hosted database only when SEED_DEMO_DATA=true.
    seed: process.env.SEED_DEMO_DATA ? process.env.SEED_DEMO_DATA === 'true' : !process.env.DATABASE_URL,
    onVercel,
  };
}

let dbPromise = null;

export function getDb() {
  dbPromise ??= (async () => {
    const cfg = config();
    if (cfg.onVercel && !cfg.databaseUrl) {
      throw new Error('DATABASE_URL is not set. Add a Postgres database (e.g. Neon) to the Vercel project.');
    }
    const db = await openDatabase({ url: cfg.databaseUrl, dataDir: LOCAL_DATA_DIR });
    if (cfg.seed) await seedDemoData(db, { log: (m) => console.log(`[seed] ${m}`) });
    return db;
  })().catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}
