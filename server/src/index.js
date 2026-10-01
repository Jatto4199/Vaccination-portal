// Standalone server: `npm run dev` / `npm start`.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { config, getDb } from './runtime.js';
import { runReminders } from './reminders.js';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(here, '../../.env');
const PORT = Number(process.env.PORT ?? 4000);

// The npm scripts load .env. On the first local run there is none yet, so one
// is created with a random JWT secret. In production the secret must be provided.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('JWT_SECRET must be set in production. Generate one with: openssl rand -hex 32');
    process.exit(1);
  }
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, `# Local settings (not committed). See .env.example.\nJWT_SECRET=${randomBytes(32).toString('hex')}\n`);
    console.log('Created .env with a random JWT_SECRET.');
  }
  process.loadEnvFile(ENV_FILE);
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is empty in .env. Set it to a long random value (openssl rand -hex 32).');
    process.exit(1);
  }
}

const cfg = config();
await getDb();
console.log(cfg.databaseUrl ? 'Using PostgreSQL from DATABASE_URL' : 'Using the embedded PostgreSQL database in server/data/pgdata');

const app = createApp({
  getDb, jwtSecret: process.env.JWT_SECRET, cronSecret: cfg.cronSecret, staticDir: join(here, '../../client/dist'),
});
app.listen(PORT, () => console.log(`Vaccination registry server on http://localhost:${PORT}`));

// Daily schedule refresh and SMS reminders (on Vercel, Vercel Cron does this).
setInterval(async () => {
  try {
    console.log('Reminder run:', await runReminders(await getDb()));
  } catch (err) {
    console.error('Reminder run failed', err);
  }
}, 6 * 60 * 60 * 1000);
