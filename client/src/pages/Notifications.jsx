// Notification interface (sections 3.7.1, 3.11): reminders generated on this
// node when a dose becomes upcoming, due or overdue.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db.js';
import { timeAgo } from '../format.js';
import { Empty, Loading } from '../components/ui.jsx';

export default function Notifications() {
  const [show, setShow] = useState('unread');
  const notifications = useLiveQuery(async () => {
    const all = await db.notifications.orderBy('created_at').reverse().toArray();
    return show === 'unread' ? all.filter((n) => !n.read) : all;
  }, [show]);

  const markRead = (ids) => db.notifications.where('id').anyOf(ids).modify({ read: 1 });

  if (!notifications) return <Loading />;
  const order = { overdue: 0, due: 1, upcoming: 2 };
  const sorted = [...notifications].sort((a, b) => a.read - b.read || order[a.type] - order[b.type] || b.created_at.localeCompare(a.created_at));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="muted">Reminders for health workers, created when a vaccination becomes upcoming, due or overdue.</p>
        </div>
        {show === 'unread' && sorted.length > 0 && (
          <button className="btn" onClick={() => markRead(sorted.map((n) => n.id))}>Mark all as read</button>
        )}
      </div>
      <div className="segmented">
        {[['unread', 'Unread'], ['all', 'All']].map(([value, label]) => (
          <button key={value} className={show === value ? 'active' : ''} onClick={() => setShow(value)}>{label}</button>
        ))}
      </div>
      <section className="card">
        {sorted.length === 0 ? <Empty>No {show === 'unread' ? 'unread ' : ''}notifications.</Empty> : (
          <ul className="list notifications">
            {sorted.slice(0, 300).map((n) => (
              <li key={n.id} className={n.read ? 'read' : ''}>
                <span className={`chip chip-${n.type}`}>{n.title}</span>
                <Link to={`/patients/${n.patient_id}/schedule`} onClick={() => markRead([n.id])}>{n.message}</Link>
                <span className="muted">{n.detail ? `${n.detail} · ` : ''}{timeAgo(n.created_at)}</span>
                {!n.read && <button className="btn-link" onClick={() => markRead([n.id])}>Mark read</button>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
