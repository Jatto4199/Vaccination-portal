// Authentication and role-based access control (thesis sections 3.15.1, 3.15.2).
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { DEFAULT_PASSWORD } from '../shared/index.js';

const TOKEN_TTL = '7d';

// Login lockout: after MAX_FAILED_LOGINS wrong passwords in a row the account
// is locked for LOCK_MINUTES. Stored in the database, so it also works when
// the API runs as several serverless instances.
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

// Passwords are stored as "scrypt$<salt>$<hash>", never in plain text.
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

export function publicUser(user) {
  return {
    id: user.id,
    full_name: user.full_name,
    username: user.username,
    email: user.email ?? null,
    role: user.role,
    clinic_id: user.clinic_id,
    must_change_password: Boolean(user.must_change_password),
  };
}

export function checkNewPassword(password, current) {
  if (typeof password !== 'string' || password.length < 8) return 'The new password must be at least 8 characters';
  if (password === DEFAULT_PASSWORD) return 'Choose a password other than the default temporary password';
  if (current !== undefined && password === current) return 'The new password must be different from the current one';
  return null;
}

export function signToken(user, secret) {
  return jwt.sign(publicUser(user), secret, { subject: user.id, expiresIn: TOKEN_TTL });
}

// Express middleware: requires a valid token and an active account.
export function requireAuth(secret) {
  return async (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Login required' });
    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      return res.status(401).json({ error: 'Session expired, please log in again' });
    }
    const user = await req.db.one('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!user || user.account_status !== 'active') {
      return res.status(401).json({ error: 'Account is disabled' });
    }
    // Tokens issued before the last password change or reset stop working.
    if (user.password_changed_at && payload.iat < Math.floor(Date.parse(user.password_changed_at) / 1000)) {
      return res.status(401).json({ error: 'Your password was changed, please log in again' });
    }
    req.user = publicUser(user);
    req.nodeId = req.get('x-node-id') ?? null;
    next();
  };
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Not permitted' });
    next();
  };
}
