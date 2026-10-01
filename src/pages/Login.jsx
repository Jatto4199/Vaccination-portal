import { useState } from 'react';
import { login } from '../auth.js';
import { useOnline } from '../hooks.js';
import { Alert, Field } from '../components/ui.jsx';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const online = useOnline();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width="48" height="48" />
        <h1>Vaccination Registry</h1>
        <p className="muted">Maternal and child immunization records</p>
        {!online && <Alert kind="warn">You are offline. You can log in if you have logged in on this device before.</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
    </div>
  );
}
