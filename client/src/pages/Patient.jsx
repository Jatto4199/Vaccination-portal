// Patient profile, vaccination schedule page and vaccination history page
// (thesis sections 3.7.1 and 3.16).
import { useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { describeAge, STATUS, todayISO, ACTIONABLE } from '@vax/shared';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db.js';
import { useClinicData, useSession } from '../hooks.js';
import { recordVaccination, voidVaccination } from '../repo.js';
import { fmtDate, fmtDateTime, vaccineLabel, vaccineName } from '../format.js';
import { Alert, Empty, Field, Loading, Modal, StatusChip } from '../components/ui.jsx';

const RECORDABLE = new Set([STATUS.OVERDUE, STATUS.DUE, STATUS.UPCOMING, STATUS.SCHEDULED]);

function usePatient() {
  const { id } = useParams();
  const data = useClinicData();
  const syncIssues = useLiveQuery(() => db.sync_records.where('record_id').equals(id)
    .filter((s) => s.conflict_status === 'pending_review' || s.sync_status === 'failed').toArray(), [id], []);
  if (!data) return { loading: true };
  const patient = data.allPatients.find((p) => p.id === id);
  return {
    data, patient, syncIssues,
    schedule: (data.schedulesByPatient.get(id) ?? []).sort((a, b) => (data.vaccines.get(a.vaccine_id)?.sort_order ?? 0) - (data.vaccines.get(b.vaccine_id)?.sort_order ?? 0)),
    records: data.records.filter((r) => r.patient_id === id).sort((a, b) => b.date_administered.localeCompare(a.date_administered)),
  };
}

function PatientShell({ ctx, children }) {
  if (ctx.loading) return <Loading />;
  const { patient, data, syncIssues } = ctx;
  if (!patient) return <Alert kind="error">This patient is not on this device. <Link to="/patients">Back to patient search</Link></Alert>;
  if (patient.merged_into_id) {
    return <Alert>This record was merged into another record. <Link to={`/patients/${patient.merged_into_id}`}>Open the current record</Link></Alert>;
  }
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{patient.full_name}</h1>
          <p className="muted mono">
            {patient.patient_number} · {patient.type === 'child' ? 'Child' : 'Mother'}
            {data.unsynced.has(patient.id) && <span className="tag">not synced</span>}
          </p>
        </div>
        <Link className="btn" to={`/patients/${patient.id}/edit`}>Edit details</Link>
      </div>
      {syncIssues.some((s) => s.conflict_status === 'pending_review') && (
        <Alert kind="warn">A change to this record conflicted with another clinic and is waiting for an administrator to review it.</Alert>
      )}
      {syncIssues.filter((s) => s.sync_status === 'failed').map((s) => (
        <Alert key={s.id} kind="error">The server did not accept a change: {s.error}</Alert>
      ))}
      <nav className="tabs">
        <NavLink to={`/patients/${patient.id}`} end>Profile</NavLink>
        <NavLink to={`/patients/${patient.id}/schedule`}>Vaccination schedule</NavLink>
        <NavLink to={`/patients/${patient.id}/history`}>Vaccination history</NavLink>
      </nav>
      {children}
    </div>
  );
}

export function PatientProfile() {
  const ctx = usePatient();
  return (
    <PatientShell ctx={ctx}>
      {ctx.patient && <ProfileBody {...ctx} />}
    </PatientShell>
  );
}

function ProfileBody({ patient, data, schedule, records }) {
  const guardian = data.guardians.get(patient.guardian_id);
  const mother = guardian?.patient_id && guardian.patient_id !== patient.id ? data.patientsById.get(guardian.patient_id) : null;
  const children = patient.type === 'mother' ? data.patients.filter((p) => p.type === 'child' && p.guardian_id === patient.guardian_id) : [];
  const nextDue = schedule.filter((s) => ACTIONABLE.includes(s.status) || s.status === STATUS.SCHEDULED).slice(0, 5);
  const given = records.filter((r) => r.record_status !== 'voided').length;

  return (
    <>
      <div className="grid-2">
        <section className="card">
          <h2>Demographic information</h2>
          <dl className="details">
            {patient.dob && <><dt>Date of birth</dt><dd>{fmtDate(patient.dob)} ({describeAge(patient.dob)})</dd></>}
            {patient.sex && patient.type === 'child' && <><dt>Sex</dt><dd>{patient.sex === 'F' ? 'Female' : 'Male'}</dd></>}
            <dt>Address</dt><dd>{patient.address || '—'}</dd>
            <dt>Registered</dt><dd>{fmtDate(patient.registration_date)}</dd>
            <dt>Clinic</dt><dd>{data.clinics.get(patient.clinic_id)?.name ?? 'Another clinic'}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>{patient.type === 'child' ? 'Guardian details' : 'Contact details'}</h2>
          {guardian ? (
            <dl className="details">
              {patient.type === 'child' && <><dt>Name</dt><dd>{guardian.full_name} ({guardian.relationship})</dd></>}
              <dt>Telephone</dt><dd>{guardian.phone ? <a href={`tel:${guardian.phone}`}>{guardian.phone}</a> : '—'}</dd>
              <dt>Notification</dt><dd>{{ sms: 'SMS', call: 'Phone call', none: 'None' }[guardian.preferred_notification] ?? '—'}{guardian.sms_consent ? ' · SMS consent given' : ' · no SMS consent'}</dd>
              {guardian.id_number && <><dt>ID number</dt><dd>{guardian.id_number}</dd></>}
              {mother && <><dt>Mother's record</dt><dd><Link to={`/patients/${mother.id}`}>{mother.patient_number}</Link></dd></>}
            </dl>
          ) : <Empty>No contact details recorded.</Empty>}
          {children.length > 0 && (
            <>
              <h3>Children</h3>
              <ul className="list">{children.map((c) => <li key={c.id}><Link to={`/patients/${c.id}`}>{c.full_name}</Link><span className="muted">born {fmtDate(c.dob)}</span></li>)}</ul>
            </>
          )}
        </section>
      </div>
      <section className="card">
        <div className="card-head">
          <h2>Upcoming vaccination requirements</h2>
          <span className="muted">{given} dose{given === 1 ? '' : 's'} recorded</span>
        </div>
        {nextDue.length === 0 ? <Empty>No outstanding vaccinations.</Empty> : (
          <ul className="list">
            {nextDue.map((s) => (
              <li key={s.id}>
                <StatusChip status={s.status} />
                <span>{vaccineLabel(data.vaccines, s.vaccine_id)}</span>
                <span className="muted">due {fmtDate(s.expected_due_date)}</span>
              </li>
            ))}
          </ul>
        )}
        <Link className="btn" to={`/patients/${patient.id}/schedule`}>Open full schedule</Link>
      </section>
    </>
  );
}

function RecordDose({ patient, row, vaccine, onClose }) {
  const [date, setDate] = useState(todayISO());
  const [batch, setBatch] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const tooEarly = row.earliest_date && date < row.earliest_date;

  async function save(e) {
    e.preventDefault();
    if (!date || date > todayISO()) return setError('Enter a date that is not in the future');
    if (patient.dob && date < patient.dob) return setError('The date cannot be before the date of birth');
    setBusy(true);
    try {
      await recordVaccination({ patientId: patient.id, vaccine, dateAdministered: date, batchNumber: batch.trim() });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Record ${vaccine.name} dose ${vaccine.dose_number}`} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <p className="muted">Patient: <strong>{patient.full_name}</strong> · Expected {fmtDate(row.expected_due_date)}</p>
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Date administered"><input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Batch / lot number (optional)"><input value={batch} onChange={(e) => setBatch(e.target.value)} /></Field>
        {tooEarly && (
          <Alert kind="warn">
            This is earlier than the minimum age or interval for this dose (earliest valid date: {fmtDate(row.earliest_date)}).
            It will be recorded but marked as possibly invalid.
          </Alert>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>Save vaccination</button>
        </div>
      </form>
    </Modal>
  );
}

export function PatientSchedule() {
  const ctx = usePatient();
  const { user } = useSession();
  const [recording, setRecording] = useState(null);
  const { patient, data, schedule } = ctx;
  const canRecord = Boolean(user.clinic_id);

  return (
    <PatientShell ctx={ctx}>
      {patient && (
        <section className="card">
          <p className="muted">Expected dates are calculated from the date of birth, the configured schedule and the doses already given.</p>
          <table className="table">
            <thead><tr><th>Vaccine</th><th>Dose</th><th>Expected due date</th><th>Status</th><th>Administered</th><th /></tr></thead>
            <tbody>
              {schedule.map((row) => {
                const vaccine = data.vaccines.get(row.vaccine_id);
                return (
                  <tr key={row.id} className={`row-${row.status}`}>
                    <td>{vaccineName(data.vaccines, row.vaccine_id)}</td>
                    <td>{row.dose_number}</td>
                    <td>{row.status === STATUS.WAITING ? <span className="muted">after {row.waiting_for}</span> : fmtDate(row.expected_due_date)}</td>
                    <td><StatusChip status={row.status} />{row.early && <span className="tag tag-warn" title="Given before the minimum age or interval">early</span>}</td>
                    <td>{fmtDate(row.actual_administration_date)}</td>
                    <td>{canRecord && vaccine && RECORDABLE.has(row.status) && <button className="btn btn-small" onClick={() => setRecording({ row, vaccine })}>Record</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {recording && <RecordDose patient={patient} {...recording} onClose={() => setRecording(null)} />}
    </PatientShell>
  );
}

function VoidDose({ record, vaccines, onClose }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    if (!reason.trim()) return setError('Give a reason so the correction can be traced');
    try {
      await voidVaccination(record, reason.trim());
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal title="Void vaccination record" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <p>
          {vaccineLabel(vaccines, record.vaccine_id)}, given {fmtDate(record.date_administered)}.
          The record stays in the history marked as voided; it is not deleted.
        </p>
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Recorded for the wrong child" autoFocus /></Field>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger">Void record</button>
        </div>
      </form>
    </Modal>
  );
}

export function PatientHistory() {
  const ctx = usePatient();
  const { user } = useSession();
  const [voiding, setVoiding] = useState(null);
  const { patient, data, records } = ctx;

  return (
    <PatientShell ctx={ctx}>
      {patient && (
        <section className="card">
          {records.length === 0 ? <Empty>No vaccinations recorded.</Empty> : (
            <table className="table">
              <thead><tr><th>Date administered</th><th>Vaccine</th><th>Dose</th><th>Clinic</th><th>Health worker</th><th>Batch</th><th /></tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className={r.record_status === 'voided' ? 'row-voided' : ''}>
                    <td>{fmtDate(r.date_administered)}</td>
                    <td>{vaccineName(data.vaccines, r.vaccine_id)}</td>
                    <td>{r.dose_number}</td>
                    <td>{data.clinics.get(r.clinic_id)?.code ?? '—'}</td>
                    <td>{r.administered_by_name ?? '—'}</td>
                    <td>{r.batch_number ?? '—'}</td>
                    <td>
                      {r.record_status === 'voided'
                        ? <span className="tag" title={fmtDateTime(r.voided_at)}>voided: {r.void_reason}</span>
                        : r.clinic_id === user.clinic_id && <button className="btn-link" onClick={() => setVoiding(r)}>Void</button>}
                      {data.unsynced.has(r.id) && <span className="tag">not synced</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {voiding && <VoidDose record={voiding} vaccines={data.vaccines} onClose={() => setVoiding(null)} />}
    </PatientShell>
  );
}
