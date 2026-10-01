// Synchronization status and this node's Synchronization Records (section 3.12.8).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db.js';
import { useOnline, usePendingCount, useSyncState } from '../hooks.js';
import { syncNow, retryFailed } from '../sync.js';
import { fmtDateTime, timeAgo, timeUntil } from '../format.js';
import { describeSync } from '../components/SyncBadge.jsx';
import { Alert, Empty, Loading } from '../components/ui.jsx';

const TABLE_LABELS = { patients: 'Patient', guardians: 'Guardian', vaccination_records: 'Vaccination record' };
const CONFLICT_LABELS = { none: '', auto_resolved: 'merged automatically', pending_review: 'sent for review' };

export default function SyncStatus() {
  const sync = useSyncState();
  const pending = usePendingCount();
  const online = useOnline();
  const [show, setShow] = useState('all');
  const nodeId = useLiveQuery(() => db.meta.get('nodeId'), []);
  const records = useLiveQuery(async () => {
    const all = await db.sync_records.orderBy('timestamp').reverse().limit(500).toArray();
    return show === 'all' ? all : all.filter((r) => r.sync_status === show);
  }, [show]);
  const failed = useLiveQuery(() => db.sync_records.where('sync_status').equals('failed').count(), [], 0);
  const names = useLiveQuery(async () => {
    const [patients, guardians] = await Promise.all([db.patients.toArray(), db.guardians.toArray()]);
    return new Map([...patients, ...guardians].map((r) => [r.id, r.full_name]));
  }, []);
  const records2patient = useLiveQuery(async () => new Map((await db.vaccination_records.toArray()).map((r) => [r.id, r.patient_id])), []);

  if (!records || !names || !records2patient) return <Loading />;
  const info = describeSync(sync, pending, online);
  const label = (r) => {
    if (r.table_name === 'vaccination_records') {
      const pid = records2patient.get(r.record_id);
      return { text: `for ${names.get(pid) ?? 'patient'}`, link: pid && `/patients/${pid}/history` };
    }
    return { text: names.get(r.record_id) ?? r.record_id.slice(0, 8), link: r.table_name === 'patients' && `/patients/${r.record_id}` };
  };

  return (
    <div className="stack">
      <h1>Synchronization</h1>
      <div className="grid-2">
        <section className="card">
          <p className={`sync-line sync-${info.tone}`}><span className="dot" /> {info.text}</p>
          <dl className="details">
            <dt>Node identifier</dt><dd className="mono">{nodeId?.value ?? '—'}</dd>
            <dt>Last successful sync</dt><dd>{timeAgo(sync.lastSyncAt)}</dd>
            <dt>Records waiting</dt><dd>{pending}</dd>
            <dt>Failed changes</dt><dd>{failed}</dd>
            {sync.nextRetryAt && <><dt>Next retry</dt><dd>in {timeUntil(sync.nextRetryAt)} (attempt {sync.failures + 1})</dd></>}
          </dl>
          {sync.error && <Alert kind="error">{sync.error}</Alert>}
          <div className="actions start">
            <button className="btn btn-primary" onClick={syncNow} disabled={sync.status === 'syncing'}>Sync now</button>
            {failed > 0 && <button className="btn" onClick={retryFailed}>Retry failed changes</button>}
          </div>
        </section>
        <section className="card">
          <h2>How synchronization works</h2>
          <p className="muted">
            Every change is saved on this device first and listed below as <b>pending</b>. When the server can be reached,
            pending changes are sent and changes from other clinics are received. If the server cannot be reached, the
            device retries automatically, waiting a little longer each time. Changes that conflict with another clinic are
            merged automatically or sent to an administrator for review.
          </p>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Synchronization records</h2>
          <div className="segmented">
            {[['all', 'All'], ['pending', 'Pending'], ['synced', 'Synced'], ['failed', 'Failed']].map(([v, l]) => (
              <button key={v} className={show === v ? 'active' : ''} onClick={() => setShow(v)}>{l}</button>
            ))}
          </div>
        </div>
        {records.length === 0 ? <Empty>No changes have been made on this device{show !== 'all' ? ' with this status' : ''}.</Empty> : (
          <table className="table">
            <thead><tr><th>Time</th><th>Change</th><th>Record</th><th>Version</th><th>Status</th></tr></thead>
            <tbody>
              {records.map((r) => {
                const { text, link } = label(r);
                return (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.timestamp)}</td>
                    <td>{TABLE_LABELS[r.table_name]} {r.change_type}</td>
                    <td>{link ? <Link to={link}>{text}</Link> : text}</td>
                    <td>{r.version_number ?? '—'}</td>
                    <td>
                      <span className={`tag tag-${r.sync_status}`}>{r.sync_status}</span>
                      {CONFLICT_LABELS[r.conflict_status] && <span className="tag tag-warn">{CONFLICT_LABELS[r.conflict_status]}</span>}
                      {r.error && <div className="field-error">{r.error}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
