import { useState } from 'react';
import { api } from '../../api.js';
import { syncNow } from '../../sync.js';
import { fmtDate, fmtDateTime } from '../../format.js';
import { Alert, Empty, Loading } from '../../components/ui.jsx';
import { useRemote } from './useRemote.js';

const FIELD_LABELS = { dob: 'Date of birth', sex: 'Sex', type: 'Patient type', phone: 'Phone', full_name: 'Name', address: 'Address' };

const describePatient = (p) => p && `${p.full_name} (${p.patient_number}${p.dob ? `, born ${fmtDate(p.dob)}` : ''})`;
const describeEvent = (e) => e && `${e.vaccine_id} on ${fmtDate(e.date_administered)}, ${e.administered_by_name ?? 'unknown'}${e.record_status === 'voided' ? ' (voided)' : ''}`;

function ConflictCard({ conflict, onResolve }) {
  const { kind, record, other_record: other } = conflict;
  const actions = {
    field: [['keep_server', `Keep "${conflict.server_value}"`], ['use_local', `Use "${conflict.local_value}"`]],
    duplicate_dose: [['void_record', 'Void the newer record'], ['void_other', 'Void the older record'], ['keep_both', 'Keep both']],
    possible_duplicate: [['merge', `Merge into ${other?.patient_number}`], ['not_duplicate', 'Different people']],
  }[kind];

  return (
    <article className="conflict">
      <header>
        <strong>
          {kind === 'field' && `${FIELD_LABELS[conflict.field] ?? conflict.field} changed at two places`}
          {kind === 'duplicate_dose' && 'Same dose recorded twice'}
          {kind === 'possible_duplicate' && 'Possible duplicate patient'}
        </strong>
        <span className="muted">{fmtDateTime(conflict.created_at)} · from {conflict.user_name ?? 'unknown user'}</span>
      </header>
      {kind === 'field' && (
        <p>{describePatient(record) ?? conflict.record_id}: the server has <b>{conflict.server_value ?? 'empty'}</b>, a device sent <b>{conflict.local_value ?? 'empty'}</b>.</p>
      )}
      {kind === 'duplicate_dose' && (
        <ul><li>Newer: {describeEvent(record)}</li><li>Older: {describeEvent(other)}</li></ul>
      )}
      {kind === 'possible_duplicate' && (
        <>
          <ul><li>New: {describePatient(record)}</li><li>Existing: {describePatient(other)}</li></ul>
          <p className="muted">Reason: {conflict.detail}. Merging keeps the existing record and moves all vaccinations to it.</p>
        </>
      )}
      <div className="actions">
        {actions.map(([action, label]) => (
          <button key={action} className="btn btn-small" onClick={() => onResolve(conflict, action)}>{label}</button>
        ))}
      </div>
    </article>
  );
}

export default function Conflicts() {
  const [status, setStatus] = useState('pending');
  const conflicts = useRemote(`/admin/conflicts?status=${status}`);
  const [error, setError] = useState(null);

  async function resolve(conflict, action) {
    setError(null);
    const body = { action };
    if (action === 'merge') body.keep_id = conflict.other_record_id;
    try {
      await api(`/admin/conflicts/${conflict.id}/resolve`, { method: 'POST', body });
      conflicts.reload();
      syncNow();
    } catch (err) {
      setError(err.message);
    }
  }

  async function acknowledge(conflict) {
    await resolve(conflict, 'acknowledge');
  }

  return (
    <div className="stack">
      <h1>Conflicts</h1>
      <p className="muted">
        Created when clinics change the same record while offline. Critical details and duplicates wait here for review;
        other fields are resolved automatically (the last change received wins) and are listed for reference.
      </p>
      <div className="segmented">
        {[['pending', 'Needs review'], ['auto_resolved', 'Resolved automatically'], ['resolved', 'Resolved']].map(([value, label]) => (
          <button key={value} className={status === value ? 'active' : ''} onClick={() => setStatus(value)}>{label}</button>
        ))}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {conflicts.error && <Alert kind="error">{conflicts.error}</Alert>}
      {!conflicts.data ? (!conflicts.error && <Loading />) : conflicts.data.conflicts.length === 0 ? <Empty>Nothing here.</Empty> : (
        <div className="stack">
          {status === 'pending' && conflicts.data.conflicts.map((c) => <ConflictCard key={c.id} conflict={c} onResolve={resolve} />)}
          {status !== 'pending' && (
            <section className="card">
              <table className="table">
                <thead><tr><th>When</th><th>Type</th><th>Record</th><th>Detail</th><th /></tr></thead>
                <tbody>
                  {conflicts.data.conflicts.map((c) => (
                    <tr key={c.id}>
                      <td>{fmtDateTime(c.created_at)}</td>
                      <td>{c.kind === 'field' ? FIELD_LABELS[c.field] ?? c.field : c.kind.replace('_', ' ')}</td>
                      <td>{c.table_name === 'patients' ? describePatient(c.record) : describeEvent(c.record)}</td>
                      <td>
                        {c.kind === 'field' ? `"${c.server_value ?? ''}" replaced by "${c.local_value ?? ''}"` : c.detail}
                        {c.resolution && <span className="muted"> · {c.resolution.replace('_', ' ')}</span>}
                      </td>
                      <td>{c.status === 'auto_resolved' && <button className="btn-link" onClick={() => acknowledge(c)}>Mark reviewed</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
