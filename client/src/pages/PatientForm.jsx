import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { normalizeName, todayISO } from '@vax/shared';
import { db } from '../db.js';
import { useClinicData } from '../hooks.js';
import { registerPatient, updateRecord } from '../repo.js';
import { cleanPhone, fmtDate, isValidPhone } from '../format.js';
import { Alert, Field, Loading } from '../components/ui.jsx';

const emptyPatient = { type: 'child', full_name: '', dob: '', sex: '', address: '' };
const emptyGuardian = { full_name: '', relationship: 'Mother', phone: '', address: '', id_number: '', preferred_notification: 'sms', sms_consent: false };
const fromRow = (row, empty) => ({ ...empty, ...Object.fromEntries(Object.keys(empty).map((k) => [k, row[k] ?? empty[k]])) });

function validate(patient, guardian, withGuardian) {
  const errors = {};
  const isChild = patient.type === 'child';
  if (isChild && !patient.full_name.trim()) errors.full_name = 'Enter the full name';
  if (isChild && !patient.dob) errors.dob = 'Date of birth is required for a child';
  if (isChild && !patient.sex) errors.sex = 'Select sex';
  if (patient.dob && patient.dob > todayISO()) errors.dob = 'Date of birth cannot be in the future';
  if (withGuardian) {
    if (!guardian.full_name.trim()) errors.g_full_name = isChild ? "Enter the guardian's name" : 'Enter the full name';
    if (guardian.phone && !isValidPhone(guardian.phone)) errors.g_phone = 'Enter a valid phone number';
    if (guardian.sms_consent && !guardian.phone) errors.g_phone = 'A phone number is needed for SMS reminders';
  }
  return errors;
}

export default function PatientForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const data = useClinicData();

  const [patient, setPatient] = useState(emptyPatient);
  const [guardian, setGuardian] = useState(emptyGuardian);
  const [guardianId, setGuardianId] = useState(null);
  const [existingGuardianId, setExistingGuardianId] = useState(null);
  const [registerMother, setRegisterMother] = useState(false);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [loaded, setLoaded] = useState(!editing);

  useEffect(() => {
    if (!editing) return;
    (async () => {
      const p = await db.patients.get(id);
      if (!p) return setError('Patient not found on this device');
      setPatient(fromRow(p, emptyPatient));
      const g = p.guardian_id ? await db.guardians.get(p.guardian_id) : null;
      if (g) {
        setGuardian(fromRow(g, emptyGuardian));
        setGuardianId(g.id);
      }
      setLoaded(true);
    })();
  }, [editing, id]);

  const isChild = patient.type === 'child';
  const set = (field) => (e) => setPatient({ ...patient, [field]: e.target.value });
  const setG = (field) => (e) => {
    setExistingGuardianId(null);
    setGuardian({ ...guardian, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  };

  // A guardian already registered with this phone number (e.g. a sibling's mother).
  const knownGuardian = useMemo(() => {
    if (editing || !isChild || !data || cleanPhone(guardian.phone).length < 7) return null;
    return data.guardianList.find((g) => g.phone === cleanPhone(guardian.phone)) ?? null;
  }, [editing, isChild, data, guardian.phone]);

  // Possible duplicates on this device (section 3.9): same name and date of birth.
  const duplicates = useMemo(() => {
    const name = normalizeName(isChild ? patient.full_name : guardian.full_name);
    if (editing || !data || !name) return [];
    return data.patients.filter((p) => p.type === patient.type && normalizeName(p.full_name) === name
      && (!isChild || p.dob === patient.dob));
  }, [editing, data, isChild, patient.full_name, patient.dob, patient.type, guardian.full_name]);

  if (!loaded || !data) return error ? <Alert kind="error">{error}</Alert> : <Loading />;
  const showGuardian = !editing || Boolean(guardianId);

  async function submit(e) {
    e.preventDefault();
    const errs = validate(patient, guardian, showGuardian && !existingGuardianId);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (duplicates.length && !confirmDuplicate) return setError('Please confirm this is not the same patient as the one listed below.');

    const g = {
      full_name: guardian.full_name.trim(), relationship: isChild ? guardian.relationship : 'Mother',
      phone: guardian.phone ? cleanPhone(guardian.phone) : null, address: (guardian.address || patient.address).trim() || null,
      id_number: guardian.id_number.trim() || null, preferred_notification: guardian.preferred_notification, sms_consent: guardian.sms_consent,
    };
    const p = {
      type: patient.type, full_name: isChild ? patient.full_name.trim() : g.full_name, dob: patient.dob || null,
      sex: isChild ? patient.sex : 'F', address: patient.address.trim() || g.address,
    };
    try {
      if (editing) {
        await updateRecord('patients', { id, ...p });
        if (guardianId) await updateRecord('guardians', { id: guardianId, ...g });
        navigate(`/patients/${id}`);
      } else {
        const newId = await registerPatient({
          patient: p, guardian: g, existingGuardianId,
          registerMother: isChild && guardian.relationship === 'Mother' && registerMother,
        });
        navigate(`/patients/${newId}`);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  const contactFields = (
    <>
      <div className="form-grid">
        <Field label="Full name" error={errors.g_full_name}><input value={guardian.full_name} onChange={setG('full_name')} /></Field>
        {isChild && (
          <Field label="Relationship to child">
            <select value={guardian.relationship} onChange={setG('relationship')}>
              <option>Mother</option><option>Father</option><option>Grandparent</option><option>Other</option>
            </select>
          </Field>
        )}
        <Field label="Telephone number" error={errors.g_phone}><input type="tel" value={guardian.phone} onChange={setG('phone')} /></Field>
        <Field label="Identification number (optional)" hint="e.g. NIN or ANC card number"><input value={guardian.id_number} onChange={setG('id_number')} /></Field>
        <Field label="Preferred notification method">
          <select value={guardian.preferred_notification} onChange={setG('preferred_notification')}>
            <option value="sms">SMS</option><option value="call">Phone call</option><option value="none">None</option>
          </select>
        </Field>
        {isChild && <Field label="Address (if different from child)"><input value={guardian.address} onChange={setG('address')} /></Field>}
      </div>
      <label className="check">
        <input type="checkbox" checked={guardian.sms_consent} onChange={setG('sms_consent')} />
        {isChild ? 'Guardian agrees' : 'Agrees'} to receive SMS vaccination reminders
      </label>
    </>
  );

  return (
    <form className="stack form" onSubmit={submit} noValidate>
      <div className="page-head">
        <h1>{editing ? 'Edit patient' : 'Register patient'}</h1>
        <Link className="btn" to={editing ? `/patients/${id}` : '/patients'}>Cancel</Link>
      </div>
      {error && <Alert kind="error">{error}</Alert>}

      <section className="card">
        <h2>{isChild ? 'Child' : 'Mother'}</h2>
        {!editing && (
          <div className="segmented">
            <button type="button" className={isChild ? 'active' : ''} onClick={() => setPatient({ ...patient, type: 'child' })}>Child</button>
            <button type="button" className={!isChild ? 'active' : ''} onClick={() => setPatient({ ...patient, type: 'mother' })}>Mother (maternal Td)</button>
          </div>
        )}
        {isChild ? (
          <div className="form-grid">
            <Field label="Full name" error={errors.full_name}><input value={patient.full_name} onChange={set('full_name')} /></Field>
            <Field label="Date of birth" error={errors.dob}><input type="date" value={patient.dob} max={todayISO()} onChange={set('dob')} /></Field>
            <Field label="Sex" error={errors.sex}>
              <select value={patient.sex} onChange={set('sex')}>
                <option value="">Select…</option><option value="F">Female</option><option value="M">Male</option>
              </select>
            </Field>
            <Field label="Address or community"><input value={patient.address} onChange={set('address')} /></Field>
          </div>
        ) : (
          <>
            {showGuardian && contactFields}
            <div className="form-grid">
              <Field label="Date of birth (optional)" error={errors.dob}><input type="date" value={patient.dob} max={todayISO()} onChange={set('dob')} /></Field>
              <Field label="Address or community"><input value={patient.address} onChange={set('address')} /></Field>
            </div>
          </>
        )}
      </section>

      {isChild && showGuardian && (
        <section className="card">
          <h2>Mother or guardian</h2>
          {existingGuardianId ? (
            <Alert>
              Using existing guardian <strong>{guardian.full_name}</strong> ({guardian.phone}).{' '}
              <button type="button" className="btn-link" onClick={() => { setExistingGuardianId(null); setGuardian(emptyGuardian); }}>Enter a different guardian</button>
            </Alert>
          ) : (
            <>
              {contactFields}
              {!editing && guardian.relationship === 'Mother' && (
                <label className="check">
                  <input type="checkbox" checked={registerMother} onChange={(e) => setRegisterMother(e.target.checked)} />
                  Also register the mother as a patient for maternal Td vaccination
                </label>
              )}
              {knownGuardian && (
                <Alert>
                  <strong>{knownGuardian.full_name}</strong> is already registered with this phone number.{' '}
                  <button type="button" className="btn-link" onClick={() => {
                    setGuardian(fromRow(knownGuardian, emptyGuardian));
                    setExistingGuardianId(knownGuardian.id);
                  }}>Use this guardian</button>
                </Alert>
              )}
            </>
          )}
        </section>
      )}

      {duplicates.length > 0 && (
        <Alert kind="warn">
          <p>A patient with the same name{isChild ? ' and date of birth' : ''} is already registered on this device:</p>
          <ul>{duplicates.map((d) => <li key={d.id}><Link to={`/patients/${d.id}`}>{d.full_name}</Link> ({d.patient_number}{d.dob ? `, born ${fmtDate(d.dob)}` : ''})</li>)}</ul>
          <label className="check">
            <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} />
            This is a different person
          </label>
        </Alert>
      )}

      <div className="actions">
        <button className="btn btn-primary">{editing ? 'Save changes' : 'Register patient'}</button>
      </div>
    </form>
  );
}
