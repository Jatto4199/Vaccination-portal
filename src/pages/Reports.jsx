// Reporting Module (section 3.6.1, requirement 22). Calculated on the node from
// local records, so reports also work offline. Health workers see their own
// clinic; administrators can pick one clinic or all of them.
import { useMemo, useState } from 'react';
import { addPeriod, todayISO, STATUS, STATUS_LABELS, isActivePatient } from '../../shared/index.js';
import { useClinicData, useSession } from '../hooks.js';
import { downloadCsv, vaccineName } from '../format.js';
import { Empty, Loading } from '../components/ui.jsx';

// Standard dropout indicators: share of children who started a series but
// did not finish it.
const DROPOUT_PAIRS = [['PENTA-1', 'PENTA-3'], ['MCV-1', 'MCV-2']];

const givenSet = (records) => new Set(records.filter((r) => r.record_status !== 'voided').map((r) => `${r.patient_id}|${r.vaccine_id}`));

// Children who have died, moved away or are lost to follow-up are left out of
// coverage and dropout figures.
function coverage(children, records, vaccines, today) {
  const given = givenSet(records);
  return vaccines
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

function dropout(children, records, vaccines, today) {
  const given = givenSet(records);
  return DROPOUT_PAIRS.map(([firstId, lastId]) => {
    const first = vaccines.get(firstId);
    const last = vaccines.get(lastId);
    if (!first || !last) return null;
    // Children old enough to have completed the series.
    const old = children.filter((c) => addPeriod(c.dob, last.recommended_age) <= today);
    const started = old.filter((c) => given.has(`${c.id}|${firstId}`)).length;
    const finished = old.filter((c) => given.has(`${c.id}|${firstId}`) && given.has(`${c.id}|${lastId}`)).length;
    return { first, last, started, finished, pct: started ? Math.round(((started - finished) / started) * 100) : null };
  }).filter(Boolean);
}

export default function Reports() {
  const data = useClinicData();
  const { user } = useSession();
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [clinicFilter, setClinicFilter] = useState('all');
  const clinicId = user.clinic_id ?? (clinicFilter === 'all' ? null : clinicFilter);
  const today = todayISO();

  const scoped = useMemo(() => {
    if (!data) return null;
    const patients = data.patients.filter((p) => !clinicId || p.clinic_id === clinicId);
    const ids = new Set(patients.map((p) => p.id));
    const children = patients.filter((p) => p.type === 'child' && p.dob && isActivePatient(p));
    return {
      patients,
      children,
      patientRecords: data.records.filter((r) => ids.has(r.patient_id)),
      // Doses given by the clinic(s) themselves (not copied from cards).
      givenHere: data.records.filter((r) => !r.given_elsewhere && (!clinicId || r.clinic_id === clinicId)),
      schedules: data.schedules.filter((s) => ids.has(s.patient_id)),
    };
  }, [data, clinicId]);

  const rows = useMemo(() => (scoped ? coverage(scoped.children, scoped.patientRecords, data.vaccineList, today) : []), [scoped, data, today]);
  const dropouts = useMemo(() => (scoped ? dropout(scoped.children, scoped.patientRecords, data.vaccines, today) : []), [scoped, data, today]);
  const monthly = useMemo(() => {
    if (!scoped) return [];
    const counts = new Map();
    for (const r of scoped.givenHere) {
      if (r.record_status === 'voided' || !r.date_administered.startsWith(month)) continue;
      counts.set(r.vaccine_id, (counts.get(r.vaccine_id) ?? 0) + 1);
    }
    return [...counts.entries()].map(([id, n]) => ({ vaccine: data.vaccines.get(id), id, n }))
      .sort((a, b) => (a.vaccine?.sort_order ?? 0) - (b.vaccine?.sort_order ?? 0));
  }, [scoped, data, month]);
  const statusCounts = useMemo(() => {
    if (!scoped) return [];
    const counts = {};
    for (const s of scoped.schedules) counts[s.status] = (counts[s.status] ?? 0) + 1;
    return [STATUS.COMPLETED, STATUS.OVERDUE, STATUS.DUE, STATUS.UPCOMING, STATUS.SCHEDULED, STATUS.WAITING, STATUS.NOT_ELIGIBLE, STATUS.INACTIVE]
      .map((s) => ({ status: s, n: counts[s] ?? 0 }));
  }, [scoped]);

  if (!scoped) return <Loading />;
  const total = monthly.reduce((s, r) => s + r.n, 0);
  const registeredInMonth = scoped.patients.filter((p) => p.registration_date?.startsWith(month)).length;
  const scopeName = clinicId ? data.clinics.get(clinicId)?.code ?? 'clinic' : 'all-clinics';

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Reports</h1>
        <div className="actions">
          {!user.clinic_id && (
            <select value={clinicFilter} onChange={(e) => setClinicFilter(e.target.value)} aria-label="Clinic">
              <option value="all">All clinics</option>
              {[...data.clinics.values()].map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </select>
          )}
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Monthly activity</h2>
            <input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <p>{registeredInMonth} patients registered · {total} doses given</p>
          {monthly.length === 0 ? <Empty>No vaccinations recorded in this month.</Empty> : (
            <>
              <table className="table">
                <thead><tr><th>Vaccine</th><th>Dose</th><th className="num">Doses given</th></tr></thead>
                <tbody>{monthly.map((r) => (
                  <tr key={r.id}><td>{vaccineName(data.vaccines, r.id)}</td><td>{r.vaccine?.dose_number}</td><td className="num">{r.n}</td></tr>
                ))}</tbody>
              </table>
              <button className="btn btn-small" onClick={() => downloadCsv(`doses-${scopeName}-${month}.csv`, [
                ['Vaccine', 'Dose', 'Doses given'], ...monthly.map((r) => [r.vaccine?.name ?? r.id, r.vaccine?.dose_number, r.n]),
              ])}>Download CSV</button>
            </>
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
        <h2>Dropout rates</h2>
        <p className="muted">Children old enough to have finished the series who received the first dose but not the last one.</p>
        <table className="table">
          <thead><tr><th>Series</th><th className="num">Started</th><th className="num">Completed</th><th className="num">Dropout</th></tr></thead>
          <tbody>
            {dropouts.map((d) => (
              <tr key={d.first.id}>
                <td>{d.first.name}: dose {d.first.dose_number} → {d.last.dose_number}</td>
                <td className="num">{d.started}</td>
                <td className="num">{d.finished}</td>
                <td className="num">{d.pct === null ? '—' : `${d.pct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Immunization coverage (children)</h2>
          <button className="btn btn-small" onClick={() => downloadCsv(`coverage-${scopeName}-${today}.csv`, [
            ['Vaccine', 'Dose', 'Eligible', 'Vaccinated', 'Coverage %'],
            ...rows.map((r) => [r.vaccine.name, r.vaccine.dose_number, r.eligible, r.vaccinated, r.pct ?? '']),
          ])}>Download CSV</button>
        </div>
        <p className="muted">Share of active children old enough for each dose who have received it, including doses given elsewhere.</p>
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
