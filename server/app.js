import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireAuth, requireRole } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { syncRoutes } from './routes/sync.js';
import { adminRoutes } from './routes/admin.js';
import { runReminders, simulatedSender } from './reminders.js';

// getDb: async function returning the database (opened once, on first use,
// so serverless platforms such as Vercel can share it between requests).
export function createApp({ getDb, jwtSecret, cronSecret, sender = simulatedSender, staticDir } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Used by nodes to check that the server itself is reachable.
  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use('/api', (req, res, next) => {
    if (!jwtSecret) return res.status(500).json({ error: 'Server is not configured: set the JWT_SECRET environment variable.' });
    next();
  });
  app.use('/api', async (req, res, next) => {
    req.db = await getDb();
    next();
  });

  // Daily job (Vercel Cron or any scheduler): refresh schedules and send reminders.
  app.get('/api/cron/daily', async (req, res) => {
    if (!cronSecret || req.get('authorization') !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
    res.json(await runReminders(req.db, { sender }));
  });

  const auth = requireAuth(jwtSecret);
  app.use('/api/auth', authRoutes({ jwtSecret, requireAuth: auth }));
  app.use('/api/admin', auth, requireRole('admin'), adminRoutes({ sender }));
  app.use('/api', auth, syncRoutes());
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // When run as a standalone server, the built web app is served too.
  if (staticDir && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('/{*path}', (req, res) => res.sendFile(join(staticDir, 'index.html')));
  }

  app.use((err, req, res, next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
