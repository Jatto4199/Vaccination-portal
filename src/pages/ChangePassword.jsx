// Change password. Shown on its own, before anything else, when the account
// has a temporary password (new account or reset by an administrator).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { changePassword, logout } from '../auth.js';
import { OfflineError } from '../api.js';
import { Alert, Field } from '../components/ui.jsx';

export default function ChangePassword({ forced = false }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const set = (f) => (e) => setForm({ ...form, [f]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (form.next !== form.confirm) return setError('The new passwords do not match');
    setBusy(true);
    try {
      await changePassword(form.current, form.next);
      setForm({ current: '', next: '', confirm: '' });
      setDone(true);
      if (!forced) setTimeout(() => navigate('/'), 1200);
    } catch (err) {
      setError(err instanceof OfflineError ? 'Changing your password needs a connection to the server.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={forced ? 'login-card' : 'card stack form'} onSubmit={submit}>
      <h1>{forced ? 'Choose a new password' : 'Change password'}</h1>
      {forced && <p className="muted">You are using a temporary password. Choose your own password to continue.</p>}
      {error && <Alert kind="error">{error}</Alert>}
      {done && !forced && <Alert>Password changed.</Alert>}
      <Field label={forced ? 'Temporary password' : 'Current password'}>
        <input type="password" value={form.current} onChange={set('current')} autoComplete="current-password" autoFocus />
      </Field>
      <Field label="New password" hint="At least 8 characters">
        <input type="password" value={form.next} onChange={set('next')} autoComplete="new-password" />
      </Field>
      <Field label="Repeat new password">
        <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
      </Field>
      <div className="actions">
        {forced && <button type="button" className="btn" onClick={() => logout()}>Log out</button>}
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </div>
    </form>
  );
}
