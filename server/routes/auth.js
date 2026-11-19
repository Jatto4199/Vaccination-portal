import { Router } from 'express';
import { verifyPassword, signToken, publicUser, hashPassword, checkNewPassword, MAX_FAILED_LOGINS, LOCK_MINUTES } from '../auth.js';
import { serverAudit } from '../sync.js';
import { nowISO } from '../db.js';

export function authRoutes({ jwtSecret, requireAuth }) {
  const router = Router();

  // Users log in with their username or email address.
  router.post('/login', async (req, res) => {
    const { username, password } = req.body ?? {};
    const login = String(username ?? '').trim().toLowerCase();
    const nodeId = req.get('x-node-id') ?? null;
    const user = login ? await req.db.one('SELECT * FROM users WHERE username = $1 OR lower(email) = $1', [login]) : null;

    if (user?.locked_until && Date.parse(user.locked_until) > Date.now()) {
      const minutes = Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60000);
      await req.db.tx((q) => serverAudit(q, { user: null, action: 'auth.login_locked', nodeId, detail: { username: login } }));
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
    }

    const ok = Boolean(user) && user.account_status === 'active' && verifyPassword(String(password ?? ''), user.password_hash);
    let locked = false;
    await req.db.tx(async (q) => {
      if (ok) {
        await q.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
      } else if (user) {
        const failures = user.failed_logins + 1;
        locked = failures >= MAX_FAILED_LOGINS;
        await q.query('UPDATE users SET failed_logins = $1, locked_until = $2 WHERE id = $3', [
          locked ? 0 : failures, locked ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null, user.id]);
      }
      await serverAudit(q, {
        user: ok ? user : null,
        action: ok ? 'auth.login' : locked ? 'auth.account_locked' : 'auth.login_failed',
        nodeId,
        detail: ok ? null : { username: login },
      });
    });
    if (locked) return res.status(429).json({ error: `Too many failed attempts. The account is locked for ${LOCK_MINUTES} minutes.` });
    if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });
    res.json({ token: signToken(user, jwtSecret), user: publicUser(user) });
  });

  router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

  // Any user can change their own password. Required after an administrator
  // creates the account or resets the password (must_change_password).
  router.post('/password', requireAuth, async (req, res) => {
    const { current_password: current, new_password: next } = req.body ?? {};
    const user = await req.db.one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!verifyPassword(String(current ?? ''), user.password_hash)) {
      return res.status(400).json({ error: 'The current password is incorrect' });
    }
    const problem = checkNewPassword(next, current);
    if (problem) return res.status(400).json({ error: problem });
    const changedAt = nowISO();
    await req.db.tx(async (q) => {
      await q.query(`UPDATE users SET password_hash = $1, must_change_password = false, password_changed_at = $2
        WHERE id = $3`, [hashPassword(next), changedAt, user.id]);
      await serverAudit(q, { user, action: 'auth.password_changed', entity: 'users', entityId: user.id, nodeId: req.nodeId });
    });
    const updated = await req.db.one('SELECT * FROM users WHERE id = $1', [user.id]);
    res.json({ token: signToken(updated, jwtSecret), user: publicUser(updated) });
  });

  return router;
}
