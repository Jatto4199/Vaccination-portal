import { useState } from 'react';
import { api } from '../../api.js';
import { fmtDateTime } from '../../format.js';
import { Alert, Empty, Loading } from '../../components/ui.jsx';
import { useRemote } from './useRemote.js';

export default function Reminders() {
  const notifications = useRemote('/admin/notifications');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const { sent } = await api('/admin/reminders/run', { method: 'POST', body: {} });
      setMessage({ kind: 'info', text: `${sent} reminder${sent === 1 ? '' : 's'} sent.` });
      notifications.reload();
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>SMS reminders</h1>
        <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Send due reminders now'}</button>
      </div>
      <p className="muted">
        Reminders also run automatically once a day. Each dose gets at most three messages: before the due date, on the
        due date and after it becomes overdue (timings are set under Configuration). Only guardians and mothers who agreed
        to SMS are contacted. In this build SMS sending is simulated (messages are logged by the server).
      </p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {notifications.error && <Alert kind="error">{notifications.error}</Alert>}
      {!notifications.data ? (!notifications.error && <Loading />) : notifications.data.notifications.length === 0 ? <Empty>No reminders sent yet.</Empty> : (
        <section className="card">
          <table className="table">
            <thead><tr><th>Sent</th><th>Patient</th><th>Type</th><th>Phone</th><th>Message</th><th>Status</th></tr></thead>
            <tbody>
              {notifications.data.notifications.map((n) => (
                <tr key={n.id}>
                  <td>{fmtDateTime(n.created_at)}</td><td>{n.patient_name}</td><td>{n.type}</td>
                  <td className="mono">{n.phone}</td><td className="small">{n.message}</td><td>{n.status.replace('_', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
