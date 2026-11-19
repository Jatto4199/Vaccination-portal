// Authentication and session management (thesis sections 3.15.1, 3.15.5).
//
// Online: the server checks the password and returns a token.
// Offline: after a successful online login, the node keeps a PBKDF2 hash of
// the password, so the same user can log in without internet for a limited
// number of days (an administrator setting). A disabled account stops
// working at the next sync.
//
// The session lives in sessionStorage, so closing the app on a shared clinic
// device logs the user out; the layout also logs out after inactivity.

import { api, setToken, OfflineError } from './api.js';
import { db, getMeta, setMeta, pendingCount, clearPatientData, uuid, getNodeId, getDeviceId } from './db.js';
import { getSettings, loadConfig, loadStoredSettings } from './config.js';
import { refreshSchedules } from './schedules.js';

const PBKDF2_ITERATIONS = 200000;
const SESSION_KEY = 'vax.session';

let session = readSession();
const listeners = new Set();

function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (value?.token) setToken(value.token);
    return value;
  } catch {
    return null;
  }
}

function setSession(value) {
  session = value;
  setToken(value?.token ?? null);
  if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else sessionStorage.removeItem(SESSION_KEY);
  listeners.forEach((fn) => fn());
}

export const getSession = () => session;
export function subscribeSession(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const toBase64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return toBase64(bits);
}

async function rememberCredential(login, password, user, token) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cred = { salt: toBase64(salt), hash: await derive(password, salt), user, token, lastOnline: Date.now() };
  await setMeta(`cred:${login}`, cred);
  // Allow offline login with either the username or the email address.
  if (user.email && user.email.toLowerCase() !== login) await setMeta(`cred:${user.email.toLowerCase()}`, cred);
  if (user.username !== login) await setMeta(`cred:${user.username}`, cred);
}

// A node holds one clinic's data at a time. If another clinic logs in, the
// old data is removed, but only once it has all been synchronized.
async function prepareNode(user) {
  const scope = user.clinic_id ?? 'all';
  const current = await getMeta('scope');
  if (current && current !== scope) {
    if (await pendingCount() > 0) {
      throw new Error('This device has records from another clinic that have not been synced yet. Ask that clinic to log in and sync first.');
    }
    await clearPatientData();
  }
  await setMeta('scope', scope);
}

async function setNodeId(user) {
  const clinic = user.clinic_id ? await db.clinics.get(user.clinic_id) : null;
  const device = (await getDeviceId()).slice(0, 4).toUpperCase();
  await setMeta('nodeId', `NODE-${clinic?.code ?? 'ADMIN'}-${device}`);
}

export async function auditLocal(user, action, entity = null, entityId = null, detail = null) {
  await db.audit_log.add({
    id: uuid(), user_id: user.id, username: user.username, action, entity, entity_id: entityId,
    detail: detail ? JSON.stringify(detail) : null, at: new Date().toISOString(), clinic_id: user.clinic_id,
    node_id: await getNodeId(), synced: 0,
  });
}

export async function login(rawLogin, password) {
  const login = rawLogin.trim().toLowerCase();
  if (!login || !password) throw new Error('Enter your username and password');

  try {
    const { token, user } = await api('/auth/login', { method: 'POST', body: { username: login, password } });
    await prepareNode(user);
    setToken(token);
    const configChanged = await loadConfig();
    await setNodeId(user);
    await rememberCredential(login, password, user, token);
    if (configChanged) await refreshSchedules();
    setSession({ token, user, offline: false });
    return session;
  } catch (err) {
    if (!(err instanceof OfflineError)) throw err;
  }

  // No connection: try the offline login.
  const cred = await getMeta(`cred:${login}`);
  if (!cred) throw new Error('No connection to the server. The first login on this device must be done online.');
  const { offline_login_days: days } = await loadStoredSettings();
  if (Date.now() - cred.lastOnline > days * 86400000) {
    throw new Error(`Offline login has expired. Connect to the internet to log in (required every ${days} days).`);
  }
  if (await derive(password, fromBase64(cred.salt)) !== cred.hash) throw new Error('Incorrect username or password');
  if ((await getMeta('scope')) !== (cred.user.clinic_id ?? 'all')) {
    throw new Error('This device now holds another clinic\'s records. Connect to the internet to log in.');
  }
  setSession({ token: cred.token, user: cred.user, offline: true });
  await auditLocal(cred.user, 'auth.login_offline');
  return session;
}

// Changes the user's own password (online only). The server returns a new
// token because tokens issued before the change stop working; the offline
// login credential is replaced too.
export async function changePassword(currentPassword, newPassword) {
  const { token, user } = await api('/auth/password', {
    method: 'POST', body: { current_password: currentPassword, new_password: newPassword },
  });
  setToken(token);
  await rememberCredential(user.username, newPassword, user, token);
  setSession({ token, user, offline: false });
}

export async function logout(reason = 'auth.logout') {
  if (session?.user) await auditLocal(session.user, reason);
  setSession(null);
}

export const idleLogoutMinutes = () => getSettings().idle_logout_minutes;
