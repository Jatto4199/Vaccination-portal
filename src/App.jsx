import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './hooks.js';
import { startAutoSync } from './sync.js';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Patients from './pages/Patients.jsx';
import PatientForm from './pages/PatientForm.jsx';
import { PatientProfile, PatientSchedule, PatientHistory } from './pages/Patient.jsx';
import FollowUp from './pages/FollowUp.jsx';
import Notifications from './pages/Notifications.jsx';
import Reports from './pages/Reports.jsx';
import SyncStatus from './pages/SyncStatus.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import Users from './pages/admin/Users.jsx';
import Clinics from './pages/admin/Clinics.jsx';
import Configuration from './pages/admin/Configuration.jsx';
import Conflicts from './pages/admin/Conflicts.jsx';
import Reminders from './pages/admin/Reminders.jsx';
import SyncLog from './pages/admin/SyncLog.jsx';
import AuditLog from './pages/admin/AuditLog.jsx';

export default function App() {
  const session = useSession();

  useEffect(() => {
    if (session) startAutoSync();
  }, [session]);

  if (!session) return <Login />;
  if (session.user.must_change_password) {
    return <BrowserRouter><div className="login-page"><ChangePassword forced /></div></BrowserRouter>;
  }
  const isAdmin = session.user.role === 'admin';

  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/patients" element={<Patients />} />
          <Route path="/patients/new" element={<PatientForm />} />
          <Route path="/patients/:id" element={<PatientProfile />} />
          <Route path="/patients/:id/schedule" element={<PatientSchedule />} />
          <Route path="/patients/:id/history" element={<PatientHistory />} />
          <Route path="/patients/:id/edit" element={<PatientForm />} />
          <Route path="/upcoming" element={<FollowUp kind="upcoming" />} />
          <Route path="/overdue" element={<FollowUp kind="overdue" />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/sync" element={<SyncStatus />} />
          <Route path="/account/password" element={<ChangePassword />} />
          {isAdmin && (
            <>
              <Route path="/admin/users" element={<Users />} />
              <Route path="/admin/clinics" element={<Clinics />} />
              <Route path="/admin/configuration" element={<Configuration />} />
              <Route path="/admin/conflicts" element={<Conflicts />} />
              <Route path="/admin/reminders" element={<Reminders />} />
              <Route path="/admin/sync-log" element={<SyncLog />} />
              <Route path="/admin/audit" element={<AuditLog />} />
            </>
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
