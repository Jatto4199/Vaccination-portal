import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, pendingCount } from './db.js';
import { getSession, subscribeSession } from './auth.js';
import { isFollowedUpHere } from './schedules.js';
import { getSyncState, subscribeSync } from './sync.js';

export const useSession = () => useSyncExternalStore(subscribeSession, getSession);
export const useSyncState = () => useSyncExternalStore(subscribeSync, getSyncState);
export const usePendingCount = () => useLiveQuery(pendingCount, [], 0);
export const useUnreadCount = () => useLiveQuery(() => db.notifications.where('read').equals(0).count(), [], 0);

// Everything the clinical screens need, kept live as local data changes.
export function useClinicData() {
  return useLiveQuery(async () => {
    const [patients, guardians, records, schedules, vaccines, clinics, pending] = await Promise.all([
      db.patients.toArray(), db.guardians.toArray(), db.vaccination_records.toArray(), db.vaccination_schedules.toArray(),
      db.vaccines.toArray(), db.clinics.toArray(), db.sync_records.where('sync_status').equals('pending').toArray(),
    ]);
    return {
      patients: patients.filter((p) => !p.merged_into_id),
      allPatients: patients,
      patientsById: new Map(patients.map((p) => [p.id, p])),
      guardians: new Map(guardians.map((g) => [g.id, g])),
      guardianList: guardians,
      records,
      schedules,
      schedulesByPatient: Map.groupBy(schedules, (s) => s.patient_id),
      vaccines: new Map(vaccines.map((v) => [v.id, v])),
      vaccineList: vaccines,
      clinics: new Map(clinics.map((c) => [c.id, c])),
      unsynced: new Set(pending.map((s) => s.record_id)),
      // Patients this device follows up (due/overdue lists, dashboard).
      followUp: new Set(patients.filter((p) => isFollowedUpHere(p, getSession()?.user)).map((p) => p.id)),
    };
  });
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
