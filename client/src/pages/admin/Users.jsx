import { useState } from 'react';
import { DEFAULT_PASSWORD } from '@vax/shared';
import { api } from '../../api.js';
import { useSession } from '../../hooks.js';
import { fmtDate } from '../../format.js';
import { Alert, Field, Loading, Modal } from '../../components/ui.jsx';
import { useRemote } from './useRemote.js';

const ROLE_LABELS = { health_worker: 'Health worker', admin: 'Administrator' };
const blank = { full_name: '', username: '', email: '', password: DEFAULT_PASSWORD, role: 'health_worker', clinic_id: '' };

function UserForm({ clinics, onDone }) {
  const [form, setForm] = useState(blank);
  const [error, setError] = useState(null);
  const set = (f) => (e) => setForm({ ...form, [f]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    try {
      await api('/admin/users', { method: 'POST', body: form });
      onDone();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Modal title="New user" onClose={onDone}>
      <form className="stack" onSubmit={submit}>
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Full name"><input value={form.full_name} onChange={set('full_name')} autoFocus /></Field>
        <Field label="Username"><input value={form.username} onChange={set('username')} autoCapitalize="none" /></Field>
        <Field label="Email (optional)" hint="Can also be used to log in"><input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Temporary password" hint={`Default ${DEFAULT_PASSWORD}; at least 8 characters`}><input value={form.password} onChange={set('password')} /></Field>
        <Field label="Role">
          <select value={form.role} onChange={set('role')}>
            <option value="health_worker">Health worker</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
        <Field label="Clinic" hint={form.role === 'admin' ? 'Optional for administrators' : undefined}>
          <select value={form.clinic_id} onChange={set('clinic_id')}>
            <option value="">{form.role === 'admin' ? 'All clinics' : 'Select…'}</option>
            {clinics.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </select>
        </Field>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone}>Cancel</button>
          <button className="btn btn-primary">Create user</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Users() {
  const users = useRemote('/admin/users');
  const clinics = useRemote('/admin/clinics');
  const { user: me } = useSession();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  async function update(user, patch, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body: patch });
      users.reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetPassword(user) {
    const password = window.prompt(`New temporary password for ${user.full_name} (at least 8 characters):`, DEFAULT_PASSWORD);
    if (password) await update(user, { password });
  }

  if (users.error) return <Alert kind="error">{users.error}</Alert>;
  if (!users.data || !clinics.data) return <Loading />;

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Users</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New user</button>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <section className="card">
        <table className="table">
          <thead><tr><th>Name</th><th>Username / email</th><th>Role</th><th>Clinic</th><th>Account status</th><th>Date created</th><th /></tr></thead>
          <tbody>
            {users.data.users.map((u) => (
              <tr key={u.id} className={u.account_status === 'disabled' ? 'row-voided' : ''}>
                <td>{u.full_name}</td>
                <td><span className="mono">{u.username}</span>{u.email && <div className="muted small">{u.email}</div>}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>{u.clinic_name ?? 'All clinics'}</td>
                <td>{u.account_status}</td>
                <td>{fmtDate(u.date_created)}</td>
                <td className="row-actions">
                  <button className="btn-link" onClick={() => resetPassword(u)}>Reset password</button>
                  {u.id !== me.id && (u.account_status === 'active'
                    ? <button className="btn-link danger" onClick={() => update(u, { account_status: 'disabled' }, `Disable ${u.full_name}? They will be signed out at their next sync.`)}>Disable</button>
                    : <button className="btn-link" onClick={() => update(u, { account_status: 'active' })}>Enable</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {creating && <UserForm clinics={clinics.data.clinics} onDone={() => { setCreating(false); users.reload(); }} />}
    </div>
  );
}
