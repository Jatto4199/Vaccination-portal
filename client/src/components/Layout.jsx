import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db.js';
import { logout, idleLogoutMinutes } from '../auth.js';
import { useSession, useUnreadCount } from '../hooks.js';
import SyncBadge from './SyncBadge.jsx';

// Logs out after a period without activity (shared clinic devices, section 3.15.5).
function useIdleLogout() {
  useEffect(() => {
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => logout('auth.idle_logout'), idleLogoutMinutes() * 60000);
    };
    const events = ['pointerdown', 'keydown', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, []);
}

export default function Layout({ children }) {
  const { user, offline } = useSession();
  const clinic = useLiveQuery(() => (user.clinic_id ? db.clinics.get(user.clinic_id) : null), [user.clinic_id]);
  const unread = useUnreadCount();
  useIdleLogout();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width="28" height="28" />
          <div>
            <strong>Vaccination Registry</strong>
            <span>{clinic?.name ?? (user.role === 'admin' ? 'All clinics (administrator)' : '')}</span>
          </div>
        </div>
        <div className="topbar-right">
          <SyncBadge />
          <div className="user">
            <span>{user.full_name}{offline && <em> (offline login)</em>}</span>
            <button className="btn-link" onClick={() => logout()}>Log out</button>
          </div>
        </div>
      </header>
      <nav className="nav">
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/patients" end>Patients</NavLink>
        {user.clinic_id && <NavLink to="/patients/new">Register</NavLink>}
        <NavLink to="/upcoming">Upcoming</NavLink>
        <NavLink to="/overdue">Overdue</NavLink>
        <NavLink to="/notifications">Notifications{unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}</NavLink>
        <NavLink to="/reports">Reports</NavLink>
        <NavLink to="/sync">Sync</NavLink>
        {user.role === 'admin' && (
          <>
            <span className="nav-sep" />
            <NavLink to="/admin/conflicts">Conflicts</NavLink>
            <NavLink to="/admin/users">Users</NavLink>
            <NavLink to="/admin/clinics">Clinics</NavLink>
            <NavLink to="/admin/configuration">Configuration</NavLink>
            <NavLink to="/admin/reminders">SMS reminders</NavLink>
            <NavLink to="/admin/sync-log">Sync log</NavLink>
            <NavLink to="/admin/audit">Audit log</NavLink>
          </>
        )}
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
