import { getNodeId } from './db.js';

export class OfflineError extends Error {}
export class AuthError extends Error {}

let token = null;
export const setToken = (value) => { token = value; };

export async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = { 'x-node-id': await getNodeId() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal,
    });
  } catch {
    throw new OfflineError('Cannot reach the server');
  } finally {
    clearTimeout(timer);
  }

  // The server always answers in JSON; anything else means a proxy or
  // gateway answered because the server itself is unreachable.
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw new OfflineError('Cannot reach the server');
  }
  const data = await res.json();
  if (res.status === 401) throw new AuthError(data.error ?? 'Login required');
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// Detects network availability (section 3.13 step 1): checks that the server
// answers, not just that the device has Wi-Fi or mobile data.
export async function isServerReachable() {
  if (!navigator.onLine) return false;
  try {
    await api('/health', { timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}
