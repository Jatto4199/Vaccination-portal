import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { describeAge, isActivePatient, PATIENT_STATUSES } from '../../shared/index.js';
import { useClinicData, useOnline, useSession } from '../hooks.js';
import { api } from '../api.js';
import { importPatientBundle } from '../repo.js';
import { fmtDate } from '../format.js';
import { Alert, Empty, Loading } from '../components/ui.jsx';

function matches(patient, guardian, q) {
  const text = [patient.full_name, patient.patient_number, guardian?.full_name, guardian?.phone]
    .filter(Boolean).join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((word) => text.includes(word));
}

function RemoteSearch({ query, localIds }) {
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const { results } = await api(`/patients/search?q=${encodeURIComponent(query)}`);
      setResults(results.filter((r) => !localIds.has(r.id)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addToDevice(id) {
    try {
      await importPatientBundle(await api(`/patients/${id}/bundle`));
      navigate(`/patients/${id}`);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="card">
      <h2>Other clinics</h2>
      <p className="muted">Check whether this patient is already registered at another participating clinic before registering them again.</p>
      <button className="btn" onClick={search} disabled={busy}>{busy ? 'Searching…' : `Search all clinics for "${query}"`}</button>
      {error && <Alert kind="error">{error}</Alert>}
      {results && (results.length === 0 ? <Empty>No matches at other clinics.</Empty> : (
        <ul className="list">
          {results.map((r) => (
            <li key={r.id}>
              <strong>{r.full_name}</strong>
              <span className="muted">
                {r.patient_number} · {r.type === 'child' ? `born ${fmtDate(r.dob)}` : 'mother'} · {r.clinic_name}
                {r.guardian_name && ` · guardian ${r.guardian_name} ${r.guardian_phone ?? ''}`}
              </span>
              <button className="btn btn-small" onClick={() => addToDevice(r.id)}>Add to this device</button>
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}

export default function Patients() {
  const data = useClinicData();
  const { user } = useSession();
  const online = useOnline();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');

  const list = useMemo(() => {
    if (!data) return [];
    const q = query.trim();
    return data.patients
      .filter((p) => type === 'all' || p.type === type)
      .filter((p) => !q || matches(p, data.guardians.get(p.guardian_id), q))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [data, query, type]);

  if (!data) return <Loading />;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Patient search</h1>
        {user.clinic_id && <Link className="btn btn-primary" to="/patients/new">+ Register patient</Link>}
      </div>
      <div className="toolbar">
        <input className="search" type="search" placeholder="Search by name, patient number, guardian or phone" value={query}
          onChange={(e) => setQuery(e.target.value)} autoFocus />
        <div className="segmented">
          {[['all', 'All'], ['child', 'Children'], ['mother', 'Mothers']].map(([value, label]) => (
            <button key={value} className={type === value ? 'active' : ''} onClick={() => setType(value)}>{label}</button>
          ))}
        </div>
      </div>

      <section className="card">
        {list.length === 0 ? <Empty>{query ? 'No patients on this device match your search.' : 'No patients registered yet.'}</Empty> : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Patient no.</th><th>Age</th><th>Guardian / phone</th><th>Registered</th></tr>
            </thead>
            <tbody>
              {list.slice(0, 200).map((p) => {
                const g = data.guardians.get(p.guardian_id);
                return (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/patients/${p.id}`}>{p.full_name}</Link>
                      {p.type === 'mother' && <span className="tag">mother</span>}
                      {!isActivePatient(p) && <span className="tag">{PATIENT_STATUSES[p.status]?.toLowerCase() ?? p.status}</span>}
                      {data.unsynced.has(p.id) && <span className="tag">not synced</span>}
                    </td>
                    <td className="mono">{p.patient_number}</td>
                    <td>{p.dob ? describeAge(p.dob) : '—'}</td>
                    <td>{g && g.patient_id !== p.id ? `${g.full_name} · ` : ''}{g?.phone ?? '—'}</td>
                    <td>{fmtDate(p.registration_date)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {list.length > 200 && <p className="muted">Showing the first 200 of {list.length}. Refine your search.</p>}
      </section>

      {query.trim().length >= 2 && online && (
        <RemoteSearch key={query.trim()} query={query.trim()} localIds={new Set(data.allPatients.map((p) => p.id))} />
      )}
    </div>
  );
}
