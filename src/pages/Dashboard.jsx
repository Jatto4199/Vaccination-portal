import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { STATUS } from '../../shared/index.js';
import { useClinicData, useOnline, usePendingCount, useSession, useSyncState } from '../hooks.js';
import { syncNow } from '../sync.js';
import { fmtDate, timeAgo, vaccineLabel } from '../format.js';
import { describeSync } from '../components/SyncBadge.jsx';
import { Alert, Empty, Loading } from '../components/ui.jsx';

export default function Dashboard() {
  const data = useClinicData();
  const { user } = useSession();
  const sync = useSyncState();
  const pending = usePendingCount();
  const online = useOnline();

  const stats = useMemo(() => {
    if (!data) return null;
    const active = new Set(data.patients.map((p) => p.id));
    const patientsWith = (status) => new Set(data.schedules.filter((s) => s.status === status && active.has(s.patient_id)).map((s) => s.patient_id)).size;
    const recent = data.records
      .filter((r) => r.record_status !== 'voided')
      .sort((a, b) => b.date_administered.localeCompare(a.date_administered) || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
      .slice(0, 8);
    return {
      patients: data.patients.length,
      children: data.patients.filter((p) => p.type === 'child').length,
      due: patientsWith(STATUS.DUE),
      upcoming: patientsWith(STATUS.UPCOMING),
      overdue: patientsWith(STATUS.OVERDUE),
      recent,
    };
  }, [data]);

  if (!stats) return <Loading />;
  const syncInfo = describeSync(sync, pending, online);
  const offline = !online || sync.status === 'offline';

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Dashboard</h1>
        {user.clinic_id && <Link className="btn btn-primary" to="/patients/new">+ Register patient</Link>}
      </div>

      <div className="stats">
        <Link to="/patients" className="stat">
          <span>{stats.patients}</span>Registered patients
          <small>{stats.children} {stats.children === 1 ? 'child' : 'children'} · {stats.patients - stats.children} mothers</small>
        </Link>
        <Link to="/upcoming" className="stat stat-due"><span>{stats.due}</span>Due today</Link>
        <Link to="/upcoming" className="stat stat-upcoming"><span>{stats.upcoming}</span>Upcoming vaccinations</Link>
        <Link to="/overdue" className="stat stat-overdue"><span>{stats.overdue}</span>Overdue vaccinations</Link>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Recent vaccination records</h2>
          {stats.recent.length === 0 ? <Empty>No vaccinations recorded yet.</Empty> : (
            <ul className="list">
              {stats.recent.map((r) => (
                <li key={r.id}>
                  <Link to={`/patients/${r.patient_id}/history`}>{data.patientsById.get(r.patient_id)?.full_name ?? 'Unknown patient'}</Link>
                  <span className="muted">{vaccineLabel(data.vaccines, r.vaccine_id)} · {fmtDate(r.date_administered)}</span>
                  {data.unsynced.has(r.id) && <span className="tag">not synced</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Synchronization status</h2>
          <p className={`sync-line sync-${syncInfo.tone}`}><span className="dot" /> {syncInfo.text}</p>
          <dl className="details">
            <dt>Last successful sync</dt><dd>{timeAgo(sync.lastSyncAt)}</dd>
            <dt>Records waiting</dt><dd>{pending}</dd>
            <dt>Server</dt><dd>{offline ? 'Not reachable' : 'Reachable'}</dd>
          </dl>
          {sync.error && <Alert kind="error">{sync.error}</Alert>}
          {offline && <p className="muted">You can keep working. Changes are saved on this device and sync automatically when the connection returns.</p>}
          <div className="actions start">
            <button className="btn" onClick={syncNow} disabled={sync.status === 'syncing'}>Sync now</button>
            <Link className="btn" to="/sync">Details</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
