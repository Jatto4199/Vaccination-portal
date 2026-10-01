// Upcoming appointments page and Overdue vaccination page (sections 3.7.1, 3.16).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { diffDays, STATUS, todayISO } from '@vax/shared';
import { useClinicData } from '../hooks.js';
import { fmtDate, vaccineLabel } from '../format.js';
import { Empty, Loading } from '../components/ui.jsx';

const KINDS = {
  upcoming: {
    title: 'Upcoming vaccinations',
    intro: 'Patients due today or in the coming days.',
    filters: [['all', 'All'], [STATUS.DUE, 'Due today'], [STATUS.UPCOMING, 'Upcoming']],
    statuses: [STATUS.DUE, STATUS.UPCOMING],
  },
  overdue: {
    title: 'Overdue vaccinations',
    intro: 'Patients whose scheduled vaccinations have not been recorded within the expected period.',
    filters: [['all', 'All'], ['30', 'Over 30 days'], ['90', 'Over 90 days']],
    statuses: [STATUS.OVERDUE],
  },
};

export default function FollowUp({ kind }) {
  const config = KINDS[kind];
  const data = useClinicData();
  const [filter, setFilter] = useState('all');
  const today = todayISO();

  const rows = useMemo(() => {
    if (!data) return [];
    const byPatient = new Map();
    for (const s of data.schedules) {
      if (!config.statuses.includes(s.status)) continue;
      if (kind === 'upcoming' && filter !== 'all' && s.status !== filter) continue;
      if (kind === 'overdue' && filter !== 'all' && diffDays(s.expected_due_date, today) <= Number(filter)) continue;
      const patient = data.patientsById.get(s.patient_id);
      if (!patient || patient.merged_into_id) continue;
      if (!byPatient.has(patient.id)) byPatient.set(patient.id, { patient, items: [] });
      byPatient.get(patient.id).items.push(s);
    }
    return [...byPatient.values()]
      .map((r) => ({ ...r, due: r.items.map((i) => i.expected_due_date).sort()[0] }))
      .sort((a, b) => a.due.localeCompare(b.due));
  }, [data, config, kind, filter, today]);

  if (!data) return <Loading />;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{config.title}</h1>
          <p className="muted">{config.intro}</p>
        </div>
        <button className="btn" onClick={() => window.print()}>Print list</button>
      </div>
      <div className="segmented">
        {config.filters.map(([value, label]) => (
          <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      <section className="card">
        <p className="muted">{rows.length} patient{rows.length === 1 ? '' : 's'}</p>
        {rows.length === 0 ? <Empty>No patients in this list.</Empty> : (
          <table className="table">
            <thead><tr><th>Patient</th><th>Vaccines needed</th><th>{kind === 'overdue' ? 'Due since' : 'Due'}</th><th>Contact</th></tr></thead>
            <tbody>
              {rows.map(({ patient, items, due }) => {
                const g = data.guardians.get(patient.guardian_id);
                const days = diffDays(today, due);
                return (
                  <tr key={patient.id}>
                    <td>
                      <Link to={`/patients/${patient.id}/schedule`}>{patient.full_name}</Link>
                      <div className="muted mono">{patient.patient_number}</div>
                    </td>
                    <td>{items.map((i) => vaccineLabel(data.vaccines, i.vaccine_id)).join(', ')}</td>
                    <td>
                      {fmtDate(due)}
                      <div className="muted">{days < 0 ? `${-days} days overdue` : days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}</div>
                    </td>
                    <td>
                      {g && g.patient_id !== patient.id && <>{g.full_name}<br /></>}
                      {g?.phone ? <a href={`tel:${g.phone}`}>{g.phone}</a> : <span className="muted">no phone</span>}
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
