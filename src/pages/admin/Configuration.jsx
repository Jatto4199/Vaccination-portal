// System configuration (section 3.15.2): the vaccine schedule template and
// synchronization / reminder settings. Nodes receive changes at their next sync.
import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, SETTING_LABELS } from '../../../shared/index.js';
import { api } from '../../api.js';
import { syncNow } from '../../sync.js';
import { Alert, Field, Loading, Modal } from '../../components/ui.jsx';
import { useRemote } from './useRemote.js';

function VaccineEditor({ vaccine, onClose }) {
  const [form, setForm] = useState({
    name: vaccine.name, recommended_age: vaccine.recommended_age ?? '', recommended_interval: vaccine.recommended_interval ?? '',
    min_age: vaccine.min_age ?? '', max_age: vaccine.max_age ?? '', status: vaccine.status,
  });
  const [error, setError] = useState(null);
  const set = (f) => (e) => setForm({ ...form, [f]: e.target.value });

  async function save(e) {
    e.preventDefault();
    try {
      await api(`/admin/vaccines/${vaccine.id}`, { method: 'PATCH', body: form });
      syncNow();
      onClose(true);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal title={`${vaccine.name} dose ${vaccine.dose_number}`} onClose={() => onClose(false)}>
      <form className="stack" onSubmit={save}>
        {error && <Alert kind="error">{error}</Alert>}
        <p className="muted">Ages and intervals are written as a number and a unit: 14d (days), 6w (weeks), 9m (months), 1y (years).</p>
        <Field label="Vaccine name"><input value={form.name} onChange={set('name')} /></Field>
        {vaccine.target === 'child' && <Field label="Recommended age"><input value={form.recommended_age} onChange={set('recommended_age')} /></Field>}
        <Field label="Recommended interval after previous dose"><input value={form.recommended_interval} onChange={set('recommended_interval')} /></Field>
        {vaccine.target === 'child' && (
          <>
            <Field label="Minimum age (earliest valid dose)"><input value={form.min_age} onChange={set('min_age')} /></Field>
            <Field label="Maximum age (leave empty for no limit)"><input value={form.max_age} onChange={set('max_age')} /></Field>
          </>
        )}
        <Field label="Status">
          <select value={form.status} onChange={set('status')}>
            <option value="active">Active (scheduled for patients)</option>
            <option value="inactive">Inactive (not scheduled)</option>
          </select>
        </Field>
        <div className="actions">
          <button type="button" className="btn" onClick={() => onClose(false)}>Cancel</button>
          <button className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

const blankVaccine = { code: '', name: '', dose_number: '1', target: 'child', recommended_age: '', recommended_interval: '', min_age: '', max_age: '' };

function NewVaccine({ onClose }) {
  const [form, setForm] = useState(blankVaccine);
  const [error, setError] = useState(null);
  const set = (f) => (e) => setForm({ ...form, [f]: e.target.value });
  const isChild = form.target === 'child';

  async function save(e) {
    e.preventDefault();
    try {
      await api('/admin/vaccines', { method: 'POST', body: { ...form, dose_number: Number(form.dose_number) } });
      syncNow();
      onClose(true);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal title="Add vaccine dose" onClose={() => onClose(false)}>
      <form className="stack" onSubmit={save}>
        {error && <Alert kind="error">{error}</Alert>}
        <p className="muted">
          Add one row per dose. For a vaccine with several doses, add dose 1 first, then dose 2 with an interval.
          Ages and intervals are written as 14d, 6w, 9m or 1y.
        </p>
        <div className="form-grid">
          <Field label="Code" hint="Short code, e.g. HPV. Doses of one vaccine share a code."><input value={form.code} onChange={set('code')} autoFocus /></Field>
          <Field label="Dose number"><input type="number" min="0" max="10" value={form.dose_number} onChange={set('dose_number')} /></Field>
        </div>
        <Field label="Vaccine name"><input value={form.name} onChange={set('name')} placeholder="e.g. Human Papillomavirus" /></Field>
        <Field label="For">
          <select value={form.target} onChange={set('target')}>
            <option value="child">Children</option>
            <option value="mother">Mothers</option>
          </select>
        </Field>
        <div className="form-grid">
          {isChild && <Field label="Recommended age"><input value={form.recommended_age} onChange={set('recommended_age')} placeholder="e.g. 9m" /></Field>}
          <Field label="Interval after previous dose (optional)"><input value={form.recommended_interval} onChange={set('recommended_interval')} /></Field>
          {isChild && <Field label="Minimum age (optional)" hint="Defaults to the recommended age"><input value={form.min_age} onChange={set('min_age')} /></Field>}
          {isChild && <Field label="Maximum age (optional)"><input value={form.max_age} onChange={set('max_age')} /></Field>}
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => onClose(false)}>Cancel</button>
          <button className="btn btn-primary">Add vaccine</button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsForm() {
  const remote = useRemote('/admin/settings');
  const [values, setValues] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => { if (remote.data) setValues(remote.data.settings); }, [remote.data]);
  if (remote.error) return <Alert kind="error">{remote.error}</Alert>;
  if (!values) return <Loading />;

  async function save(e) {
    e.preventDefault();
    try {
      const { settings } = await api('/admin/settings', { method: 'PUT', body: { settings: values } });
      setValues(settings);
      setMessage({ kind: 'info', text: 'Settings saved. Clinic devices receive them at their next sync.' });
      syncNow();
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>Synchronization and reminder settings</h2>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <div className="form-grid">
        {Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => (typeof fallback === 'boolean' ? (
          <label key={key} className="check">
            <input type="checkbox" checked={Boolean(values[key])} onChange={(e) => setValues({ ...values, [key]: e.target.checked })} />
            {SETTING_LABELS[key]}
          </label>
        ) : (
          <Field key={key} label={SETTING_LABELS[key]}>
            <input type="number" min="0" value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
          </Field>
        )))}
      </div>
      <div className="actions"><button className="btn btn-primary">Save settings</button></div>
    </form>
  );
}

export default function Configuration() {
  const vaccines = useRemote('/admin/vaccines');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="stack">
      <div>
        <h1>Configuration</h1>
        <p className="muted">
          The vaccination schedule template used to calculate due dates. Check it against the current national
          immunization schedule. Changing a vaccine recalculates every patient's schedule.
        </p>
      </div>
      {vaccines.error && <Alert kind="error">{vaccines.error}</Alert>}
      {!vaccines.data ? (!vaccines.error && <Loading />) : (
        <section className="card">
          <div className="card-head">
            <h2>Vaccines</h2>
            <button className="btn btn-small" onClick={() => setAdding(true)}>+ Add vaccine</button>
          </div>
          <table className="table">
            <thead><tr><th>Vaccine</th><th>Dose</th><th>For</th><th>Recommended age</th><th>Recommended interval</th><th>Min / max age</th><th>Status</th><th /></tr></thead>
            <tbody>
              {vaccines.data.vaccines.map((v) => (
                <tr key={v.id} className={v.status === 'inactive' ? 'row-voided' : ''}>
                  <td>{v.name}</td>
                  <td>{v.dose_number}</td>
                  <td>{v.target === 'child' ? 'Child' : 'Mother'}</td>
                  <td className="mono">{v.recommended_age ?? (v.target === 'mother' && v.dose_number === 1 ? 'first contact' : '—')}</td>
                  <td className="mono">{v.recommended_interval ?? '—'}</td>
                  <td className="mono">{v.min_age ?? '—'} / {v.max_age ?? 'none'}</td>
                  <td>{v.status}</td>
                  <td><button className="btn-link" onClick={() => setEditing(v)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <SettingsForm />
      {adding && <NewVaccine onClose={(changed) => { setAdding(false); if (changed) vaccines.reload(); }} />}
      {editing && <VaccineEditor vaccine={editing} onClose={(changed) => { setEditing(null); if (changed) vaccines.reload(); }} />}
    </div>
  );
}
