// Reporting Module (section 3.6.1, requirement 22). Calculated on the node from
// local records, so reports also work offline.
import { useMemo, useState } from 'react';
import { addPeriod, todayISO, STATUS, STATUS_LABELS } from '@vax/shared';
import { useClinicData } from '../hooks.js';
import { vaccineName } from '../format.js';
import { Empty, Loading } from '../components/ui.jsx';

function coverage(data) {
  const today = todayISO();
  const children = data.patients.filter((p) => p.type === 'child' && p.dob);
  const given = new Set(data.records.filter((r) => r.record_status !== 'voided').map((r) => `${r.patient_id}|${r.vaccine_id}`));
  return data.vaccineList
    .filter((v) => v.target === 'child' && v.status === 'active')
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((v) => {
      // Eligible: children who have reached the recommended age and are not past the age limit.
      const eligible = children.filter((c) => addPeriod(c.dob, v.recommended_age) <= today
        && (!v.max_age || addPeriod(c.dob, v.max_age) >= today || given.has(`${c.id}|${v.id}`)));
      const vaccinated = eligible.filter((c) => given.has(`${c.id}|${v.id}`)).length;
      return { vaccine: v, eligible: eligible.length, vaccinated, pct: eligible.length ? Math.round((vaccinated / eligible.length) * 100) : null };
    });
}

export default function Reports() {
  const data = useClinicData();
  const [month, setMonth] = useState(todayISO().slice(0, 7));

  const rows = useMemo(() => (data ? coverage(data) : []), [data]);
  const monthly = useMemo(() => {
    if (!data) return [];
    const counts = new Map();
    for (const r of data.records) {
      if (r.record_status === 'voided' || !r.date_administered.startsWith(month)) continue;
      counts.set(r.vaccine_id, (counts.get(r.vaccine_id) ?? 0) + 1);
    }
    return [...counts.entries()].map(([id, n]) => ({ vaccine: data.vaccines.get(id), id, n }))
      .sort((a, b) => (a.vaccine?.sort_order ?? 0) - (b.vaccine?.sort_order ?? 0));
  }, [data, month]);
  const statusCounts = useMemo(() => {
    if (!data) return [];
    const active = new Set(data.patients.map((p) => p.id));
    const counts = {};
    for (const s of data.schedules) if (active.has(s.patient_id)) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return [STATUS.COMPLETED, STATUS.OVERDUE, STATUS.DUE, STATUS.UPCOMING, STATUS.SCHEDULED, STATUS.WAITING, STATUS.NOT_ELIGIBLE]
      .map((s) => ({ status: s, n: counts[s] ?? 0 }));
  }, [data]);

  if (!data) return <Loading />;
  const total = monthly.reduce((s, r) => s + r.n, 0);
  const registeredInMonth = data.patients.filter((p) => p.registration_date?.startsWith(month)).length;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Reports</h1>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Monthly activity</h2>
            <input type="month" value={month} max={todayISO().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <p>{registeredInMonth} patients registered · {total} doses given</p>
          {monthly.length === 0 ? <Empty>No vaccinations recorded in this month.</Empty> : (
            <table className="table">
              <thead><tr><th>Vaccine</th><th>Dose</th><th className="num">Doses given</th></tr></thead>
              <tbody>{monthly.map((r) => (
                <tr key={r.id}><td>{vaccineName(data.vaccines, r.id)}</td><td>{r.vaccine?.dose_number}</td><td className="num">{r.n}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>Scheduled doses by status</h2>
          <table className="table">
            <tbody>{statusCounts.map((r) => (
              <tr key={r.status}><td>{STATUS_LABELS[r.status]}</td><td className="num">{r.n}</td></tr>
            ))}</tbody>
          </table>
        </section>
      </div>

      <section className="card">
        <h2>Immunization coverage (children)</h2>
        <p className="muted">Share of children old enough for each dose who have received it.</p>
        <table className="table">
          <thead><tr><th>Vaccine</th><th>Dose</th><th className="num">Eligible</th><th className="num">Vaccinated</th><th>Coverage</th></tr></thead>
          <tbody>
            {rows.map(({ vaccine, eligible, vaccinated, pct }) => (
              <tr key={vaccine.id}>
                <td>{vaccine.name}</td>
                <td>{vaccine.dose_number}</td>
                <td className="num">{eligible}</td>
                <td className="num">{vaccinated}</td>
                <td>
                  {pct === null ? <span className="muted">—</span> : (
                    <div className="bar" title={`${pct}%`}><div style={{ width: `${pct}%` }} /><span>{pct}%</span></div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
