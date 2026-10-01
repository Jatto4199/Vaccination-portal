import { useState } from 'react';
import { api } from '../../api.js';
import { loadConfig } from '../../config.js';
import { timeAgo } from '../../format.js';
import { Alert, Field, Loading } from '../../components/ui.jsx';
import { useRemote } from './useRemote.js';

const SYNC_LABELS = { never_synced: 'Never synced', synced: 'Synced', failed: 'Last sync had errors' };
const blank = { code: '', name: '', location: '', contact_phone: '', contact_email: '' };

export default function Clinics() {
  const clinics = useRemote('/admin/clinics');
  const [form, setForm] = useState(blank);
  const [error, setError] = useState(null);
  const set = (f) => (e) => setForm({ ...form, [f]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      await api('/admin/clinics', { method: 'POST', body: form });
      setForm(blank);
      clinics.reload();
      loadConfig();
    } catch (err) {
      setError(err.message);
    }
  }

  if (clinics.error) return <Alert kind="error">{clinics.error}</Alert>;
  if (!clinics.data) return <Loading />;

  return (
    <div className="stack">
      <div>
        <h1>Clinics</h1>
        <p className="muted">Each participating healthcare facility is a node that keeps its own copy of its patients' records.</p>
      </div>
      <section className="card">
        <table className="table">
          <thead><tr><th>Code</th><th>Clinic</th><th>Contact</th><th>Node identifier</th><th className="num">Patients</th><th className="num">Staff</th><th>Synchronization status</th></tr></thead>
          <tbody>
            {clinics.data.clinics.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.code}</td>
                <td>{c.name}<div className="muted small">{c.location}</div></td>
                <td className="small">{[c.contact_phone, c.contact_email].filter(Boolean).join(' · ') || '—'}</td>
                <td className="mono small">{c.node_id}</td>
                <td className="num">{c.patients}</td>
                <td className="num">{c.staff}</td>
                <td>
                  <span className={`tag tag-${c.sync_status}`}>{SYNC_LABELS[c.sync_status]}</span>
                  <div className="muted small">{c.last_sync_at ? `last ${timeAgo(c.last_sync_at)}` : ''}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <form className="card stack" onSubmit={submit}>
        <h2>Add a clinic</h2>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="form-grid">
          <Field label="Code" hint="Short code used in patient numbers, e.g. CLN04"><input value={form.code} onChange={set('code')} /></Field>
          <Field label="Clinic name"><input value={form.name} onChange={set('name')} /></Field>
          <Field label="Location"><input value={form.location} onChange={set('location')} /></Field>
          <Field label="Contact phone"><input type="tel" value={form.contact_phone} onChange={set('contact_phone')} /></Field>
          <Field label="Contact email"><input type="email" value={form.contact_email} onChange={set('contact_email')} /></Field>
        </div>
        <div className="actions"><button className="btn btn-primary">Add clinic</button></div>
      </form>
    </div>
  );
}
