import { fmtDateTime } from '../../format.js';
import { Alert, Loading } from '../../components/ui.jsx';
import { useRemote } from './useRemote.js';

function describeDetail(detail) {
  if (!detail) return '';
  try {
    const value = JSON.parse(detail);
    return Object.entries(value).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
  } catch {
    return detail;
  }
}

export default function AuditLog() {
  const audit = useRemote('/admin/audit?limit=300');
  if (audit.error) return <Alert kind="error">{audit.error}</Alert>;
  if (!audit.data) return <Loading />;

  return (
    <div className="stack">
      <h1>Audit log</h1>
      <p className="muted">Latest 300 entries. Actions taken offline appear here after the device syncs.</p>
      <section className="card">
        <table className="table">
          <thead><tr><th>When</th><th>User</th><th>Node</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead>
          <tbody>
            {audit.data.entries.map((e) => (
              <tr key={e.id}>
                <td>{fmtDateTime(e.at)}</td>
                <td>{e.username ?? '—'}</td>
                <td className="mono small">{e.node_id ?? '—'}</td>
                <td className="mono">{e.action}</td>
                <td className="mono small">{e.entity ? `${e.entity} ${e.entity_id?.slice(0, 8)}` : ''}</td>
                <td className="small">{describeDetail(e.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
