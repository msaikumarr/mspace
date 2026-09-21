import { useEffect } from 'react';
import { Navigate, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './store/auth';
import { refreshSession } from './services/api';
import { Loading, Toaster } from './components/ui';
import AppLayout from './layouts/AppLayout';
import Landing from './pages/Landing';
import { Login, Register, ForgotPassword, ResetPassword, VerifyEmail } from './pages/Auth';
import Overview from './pages/Overview';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Chat from './pages/Chat';
import { DocumentsPage } from './pages/Documents';
import Copilot from './pages/Copilot';
import Meetings from './pages/Meetings';
import Analytics from './pages/Analytics';
import Members from './pages/Members';
import Notifications from './pages/Notifications';
import Settings from './pages/Settings';
import Billing from './pages/Billing';
import Admin from './pages/Admin';

function Protected() {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading label="Restoring your session…" />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  return <Outlet />;
}

function GuestOnly() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  return user ? <Navigate to="/app" replace /> : <Outlet />;
}

export default function App() {
  useEffect(() => {
    // Restore the session from the httpOnly refresh cookie on first load.
    refreshSession().then((ok) => { if (!ok) useAuth.getState().setReady(); });
  }, []);

  return (
    <>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route element={<GuestOnly />}>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
        </Route>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/app" element={<Protected />}>
          <Route element={<AppLayout />}>
            <Route index element={<Overview />} />
            <Route path="projects" element={<Projects />} />
            <Route path="projects/:id" element={<ProjectDetail />} />
            <Route path="chat" element={<Chat />} />
            <Route path="documents" element={<DocumentsPage />} />
            <Route path="copilot" element={<Copilot />} />
            <Route path="meetings" element={<Meetings />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="members" element={<Members />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="settings" element={<Settings />} />
            <Route path="billing" element={<Billing />} />
            <Route path="admin" element={<Admin />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  );
}
