// Configuration received from the server (clinics, vaccines, settings) and
// kept on the node for offline use.
import { DEFAULT_SETTINGS } from '@vax/shared';
import { api } from './api.js';
import { db, getMeta, setMeta } from './db.js';

let settings = { ...DEFAULT_SETTINGS };

export const getSettings = () => settings;

export async function loadStoredSettings() {
  settings = { ...DEFAULT_SETTINGS, ...(await getMeta('settings', {})) };
  return settings;
}

// Returns true if the vaccine configuration or schedule settings changed.
export async function loadConfig() {
  const config = await api('/config');
  const previous = JSON.stringify([await db.vaccines.toArray(), settings.upcoming_window_days, settings.overdue_grace_days]);
  await db.transaction('rw', db.clinics, db.vaccines, db.meta, async () => {
    await db.clinics.clear();
    await db.vaccines.clear();
    await db.clinics.bulkPut(config.clinics);
    await db.vaccines.bulkPut(config.vaccines);
    await setMeta('settings', config.settings);
  });
  settings = { ...DEFAULT_SETTINGS, ...config.settings };
  return previous !== JSON.stringify([config.vaccines, settings.upcoming_window_days, settings.overdue_grace_days]);
}
