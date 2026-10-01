// Synchronization Records received by the central server (section 3.12.8).
import { fmtDateTime } from '../../format.js';
import { Alert, Empty, Loading } from '../../components/ui.jsx';
import { useRemote } from './useRemote.js';

const TABLE_LABELS = { patients: 'Patient', guardians: 'Guardian', vaccination_records: 'Vaccination record' };
const CONFLICT_LABELS = { none: '—', auto_resolved: 'Resolved automatically', pending_review: 'Pending review' };

export default function SyncLog() {
  const log = useRemote('/admin/sync-records?limit=300');
  if (log.error) return <Alert kind="error">{log.error}</Alert>;
  if (!log.data) return <Loading />;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Sync log</h1>
          <p className="muted">The latest 300 changes received from clinic nodes.</p>
        </div>
        <button className="btn" onClick={log.reload}>Refresh</button>
      </div>
      <section className="card">
        {log.data.records.length === 0 ? <Empty>No changes received yet.</Empty> : (
          <table className="table">
            <thead><tr><th>Received</th><th>Clinic / node</th><th>User</th><th>Change</th><th>Record</th><th>Version</th><th>Sync status</th><th>Conflict status</th></tr></thead>
            <tbody>
              {log.data.records.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.timestamp)}</td>
                  <td>{r.clinic_code ?? '—'}<div className="mono small muted">{r.node_id}</div></td>
                  <td>{r.username ?? '—'}</td>
                  <td>{TABLE_LABELS[r.table_name] ?? r.table_name} {r.change_type}</td>
                  <td className="mono small">{r.record_id.slice(0, 8)}</td>
                  <td>{r.version_number ?? '—'}</td>
                  <td><span className={`tag tag-${r.sync_status}`}>{r.sync_status}</span>{r.error && <div className="field-error">{r.error}</div>}</td>
                  <td>{CONFLICT_LABELS[r.conflict_status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
