import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, FolderKanban, MessageSquare, FileText, Sparkles, Mic, BarChart3, Users, Bell, Settings as SettingsIcon,
  CreditCard, ShieldCheck, ChevronDown, LogOut, Menu, Plus, type LucideIcon,
} from 'lucide-react';
import { useAuth, useWorkspace } from '../store/auth';
import { api, get, post, refreshSession } from '../services/api';
import { useRealtime } from '../hooks/useRealtime';
import { useWsKey } from '../hooks/useData';
import { Avatar, Badge, Button, Input, Modal, toast } from '../components/ui';
import { cn } from '../utils';
import type { Workspace } from '../types';

const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean; badge?: boolean }[] = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/projects', label: 'Projects', icon: FolderKanban },
  { to: '/app/chat', label: 'Chat', icon: MessageSquare },
  { to: '/app/documents', label: 'Documents', icon: FileText },
  { to: '/app/copilot', label: 'AI Copilot', icon: Sparkles },
  { to: '/app/meetings', label: 'Meetings', icon: Mic },
  { to: '/app/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/app/members', label: 'Members', icon: Users },
  { to: '/app/notifications', label: 'Notifications', icon: Bell, badge: true },
  { to: '/app/settings', label: 'Settings', icon: SettingsIcon },
  { to: '/app/billing', label: 'Billing', icon: CreditCard },
];

function WorkspaceSwitcher() {
  const { workspaces, selectWorkspace, setWorkspaces } = useAuth();
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => post<Workspace>('/workspaces', { name }),
    onSuccess: (w) => { setWorkspaces([...useAuth.getState().workspaces, w]); selectWorkspace(w.id); setCreating(false); setName(''); setOpen(false); qc.clear(); toast.success('Workspace created'); },
    onError: toast.error,
  });
  return (
    <div className="relative px-3">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50" aria-haspopup="listbox" aria-expanded={open}>
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">{ws?.name[0]?.toUpperCase()}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-800">{ws?.name}</span><span className="block text-[11px] capitalize text-slate-400">{ws?.plan} plan · {ws?.role}</span></span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-3 right-3 top-full z-30 mt-1 rounded-lg border border-slate-200 bg-white p-1 shadow-lg" role="listbox">
          {workspaces.map((w) => (
            <button key={w.id} role="option" aria-selected={w.id === ws?.id} onClick={() => { selectWorkspace(w.id); setOpen(false); }} className={cn('flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50', w.id === ws?.id && 'bg-brand-50 text-brand-700')}>
              <span className="truncate">{w.name}</span><Badge>{w.role}</Badge>
            </button>
          ))}
          <button onClick={() => { setCreating(true); setOpen(false); }} className="mt-1 flex w-full items-center gap-1.5 rounded-md border-t border-slate-100 px-3 py-2 text-left text-sm text-brand-600 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" />New workspace</button>
        </div>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Create workspace">
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }} className="space-y-4">
          <Input autoFocus placeholder="e.g. Acme Design Team" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button type="submit" loading={create.isPending}>Create</Button></div>
        </form>
      </Modal>
    </div>
  );
}

/** Asks people whose address is not yet confirmed to confirm it, and lets them ask for the email again. */
function VerifyEmailBanner() {
  const user = useAuth((s) => s.user);
  const [devLink, setDevLink] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: () => api<{ sent?: boolean; devToken?: string }>('/auth/resend-verification', { method: 'POST', noWorkspace: true }),
    onSuccess: (r) => { toast.success('Confirmation email sent. Check your inbox.'); if (r.devToken) setDevLink(`/verify-email?token=${r.devToken}`); },
    onError: toast.error,
  });
  // They confirm in their mail app, then come back to this tab: re-check when it regains focus.
  const waiting = !!user?.needsEmailVerification;
  useEffect(() => {
    if (!waiting) return;
    const onFocus = () => { if (document.visibilityState === 'visible') void refreshSession({ fresh: true }); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => { document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus); };
  }, [waiting]);
  if (!waiting) return null;
  return (
    <div role="status" aria-label="Email verification" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
      <span className="min-w-0 flex-1">Please confirm your email address, <b className="break-all">{user!.email}</b>. Until you do, workspace invitations sent to it stay pending.</span>
      {devLink && <a className="font-medium underline" href={devLink}>Development: open the confirmation link</a>}
      <Button size="sm" variant="secondary" loading={resend.isPending} onClick={() => resend.mutate()}>Resend email</Button>
    </div>
  );
}

export default function AppLayout() {
  useRealtime();
  const nav = useNavigate();
  const { user, workspaceId, clear } = useAuth();
  const key = useWsKey();
  const [menu, setMenu] = useState(false);
  const notif = useQuery({ queryKey: key('notifications'), queryFn: () => get<{ unread: number }>('/notifications'), enabled: !!workspaceId, refetchInterval: 60_000 });
  const channels = useQuery({ queryKey: key('channels'), queryFn: () => get<{ unread: number }[]>('/channels'), enabled: !!workspaceId });
  const chatUnread = (channels.data || []).reduce((n, c) => n + c.unread, 0);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST', noWorkspace: true }).catch(() => undefined);
    clear();
    nav('/login');
  };

  return (
    <div className="flex h-full">
      {menu && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setMenu(false)} />}
      <aside className={cn('fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-200 bg-slate-50 py-4 transition-transform lg:static lg:translate-x-0', menu ? 'translate-x-0' : '-translate-x-full')}>
        <Link to="/app" className="mb-4 flex items-center gap-2 px-5 text-lg font-bold text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">M</span> M-Space
        </Link>
        <WorkspaceSwitcher />
        <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setMenu(false)} className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-100 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}>
              <n.icon aria-hidden className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
              <span className="flex-1">{n.label}</span>
              {n.badge && (notif.data?.unread ?? 0) > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{notif.data!.unread}</span>}
              {n.to === '/app/chat' && chatUnread > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">{chatUnread}</span>}
            </NavLink>
          ))}
          {user?.isPlatformAdmin && (
            <NavLink to="/app/admin" className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-100 text-brand-700' : 'text-slate-600 hover:bg-slate-100')}><ShieldCheck aria-hidden className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />Platform admin</NavLink>
          )}
        </nav>
        <div className="mx-3 mt-2 flex items-center gap-2 border-t border-slate-200 pt-3">
          <Avatar name={user?.name} color={user?.avatarColor} />
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{user?.name}</p><p className="truncate text-[11px] text-slate-400">{user?.email}</p></div>
          <button onClick={logout} title="Sign out" aria-label="Sign out" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><LogOut className="h-4 w-4" /></button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <VerifyEmailBanner />
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button onClick={() => setMenu(true)} aria-label="Open menu" className="rounded-md p-1.5 hover:bg-slate-100"><Menu className="h-5 w-5" /></button>
          <span className="font-semibold">M-Space</span>
        </header>
        <main className="flex-1 overflow-y-auto"><div className="mx-auto max-w-7xl p-4 sm:p-6"><Outlet /></div></main>
      </div>
    </div>
  );
}
