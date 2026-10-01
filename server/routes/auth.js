import { Router } from 'express';
import { verifyPassword, signToken, publicUser } from '../auth.js';
import { serverAudit } from '../sync.js';

export function authRoutes({ jwtSecret, requireAuth }) {
  const router = Router();

  // Users log in with their username or email address.
  router.post('/login', async (req, res) => {
    const { username, password } = req.body ?? {};
    const login = String(username ?? '').trim().toLowerCase();
    const nodeId = req.get('x-node-id') ?? null;
    const user = login ? await req.db.one('SELECT * FROM users WHERE username = $1 OR lower(email) = $1', [login]) : null;
    const ok = Boolean(user) && user.account_status === 'active' && verifyPassword(String(password ?? ''), user.password_hash);
    await req.db.tx((q) => serverAudit(q, {
      user: ok ? user : null,
      action: ok ? 'auth.login' : 'auth.login_failed',
      nodeId,
      detail: ok ? null : { username: login },
    }));
    if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });
    res.json({ token: signToken(user, jwtSecret), user: publicUser(user) });
  });

  router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  return router;
}
