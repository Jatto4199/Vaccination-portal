// Vercel serverless entry point: the whole Express API runs as one function.
// vercel.json rewrites every /api/* request here; the web app is served as
// static files from dist/ (the Vite build).
import { createApp } from '../server/app.js';
import { config, getDb } from '../server/runtime.js';

const cfg = config();

export default createApp({ getDb, jwtSecret: cfg.jwtSecret, cronSecret: cfg.cronSecret });
