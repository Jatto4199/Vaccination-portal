// Vercel serverless entry point: the whole Express API runs as one function.
// vercel.json rewrites every /api/* request here; the web app is served as
// static files from client/dist.
import { createApp } from '../server/src/app.js';
import { config, getDb } from '../server/src/runtime.js';

const cfg = config();

export default createApp({ getDb, jwtSecret: cfg.jwtSecret, cronSecret: cfg.cronSecret });
