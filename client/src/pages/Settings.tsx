import { useState } from 'react';
import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get, patch, post } from '../services/api';
import { useAuth, useWorkspace } from '../store/auth';
import { useWsKey } from '../hooks/useData';
import { Avatar, Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, toast } from '../components/ui';
import { fmtDate, timeAgo } from '../utils';
import { oauthMessage } from './Auth';

interface Connections { hasPassword: boolean; providers: { id: string; name: string; enabled: boolean; connected: boolean; email?: string }[] }

/** Social accounts that can sign in to this user, and the way to add or remove them. */
function ConnectedAccounts({ conns }: { conns?: Connections }) {
  const qc = useQueryClient();
  const connect = useMutation({
    mutationFn: (id: string) => post<{ url: string }>(`/auth/oauth/${id}/link`),
    onSuccess: (r) => window.location.assign(r.url),
    onError: toast.error,
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/auth/oauth/${id}`, { method: 'DELETE', noWorkspace: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['oauth-connections'] }); toast.success('Disconnected'); },
    onError: toast.error,
  });
  if (!conns?.providers.length) return null;
  return (
    <Card className="p-5 lg:col-span-2">
      <h3 className="font-semibold">Connected accounts</h3>
      <p className="mb-4 mt-1 text-sm text-slate-500">Sign in with these instead of a password.</p>
      <ul className="divide-y divide-slate-100">
        {conns.providers.map((p) => (
          <li key={p.id} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1"><p className="text-sm font-medium text-slate-800">{p.name}</p><p className="truncate text-xs text-slate-400">{p.connected ? `Connected${p.email ? ` as ${p.email}` : ''}` : 'Not connected'}</p></div>
            {p.connected
              ? <Button size="sm" variant="secondary" loading={disconnect.isPending && disconnect.variables === p.id} onClick={() => confirm(`Disconnect ${p.name}?`) && disconnect.mutate(p.id)} aria-label={`Disconnect ${p.name}`}>Disconnect</Button>
              : <Button size="sm" loading={connect.isPending && connect.variables === p.id} onClick={() => connect.mutate(p.id)} aria-label={`Connect ${p.name}`}>Connect</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

function Profile() {
  const { user, setSession, accessToken, workspaces } = useAuth();
  const conns = useQuery({ queryKey: ['oauth-connections'], queryFn: () => api<Connections>('/auth/oauth/connections', { noWorkspace: true }) });
  const [devLink, setDevLink] = useState<string | null>(null);
  const setPassword = useMutation({
    mutationFn: () => api<{ devToken?: string }>('/auth/forgot-password', { method: 'POST', body: { email: user!.email }, noWorkspace: true }),
    onSuccess: (d) => { toast.success('Check your email for a link to set a password'); if (d.devToken) setDevLink(`/reset-password?token=${d.devToken}`); },
    onError: toast.error,
  });
  const [params, setParams] = useSearchParams();
  const announced = useRef(false); // effects run twice in development; announce only once
  useEffect(() => {
    const linked = params.get('linked'), error = params.get('error');
    if (announced.current || (!linked && !error)) return;
    announced.current = true;
    if (linked) toast.success(`${linked[0].toUpperCase()}${linked.slice(1)} connected`);
    else toast.info(oauthMessage(error) || 'Could not connect that account.');
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [f, setF] = useState({ name: user!.name, title: user!.title || '', avatarColor: user!.avatarColor });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const save = useMutation({
    mutationFn: () => api<{ user: typeof user }>('/auth/me', { method: 'PATCH', body: f, noWorkspace: true }),
    onSuccess: (r) => { setSession({ user: r.user!, accessToken: accessToken!, workspaces }); toast.success('Profile saved'); },
  });
  const change = useMutation({
    mutationFn: () => api('/auth/change-password', { method: 'POST', body: pw, noWorkspace: true }),
    onSuccess: (d: any) => { useAuth.getState().setSession(d); setPw({ currentPassword: '', newPassword: '' }); toast.success('Password changed — other sessions were signed out'); },
  });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <h3 className="mb-4 font-semibold">Profile</h3>
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
          <div className="flex items-center gap-3"><Avatar name={f.name} color={f.avatarColor} size={48} /><div className="flex gap-1.5">{COLORS.map((c) => <button type="button" key={c} onClick={() => setF({ ...f, avatarColor: c })} className={`h-5 w-5 rounded-full ${f.avatarColor === c ? 'ring-2 ring-slate-700 ring-offset-1' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} />)}</div></div>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={100} /></Field>
          <Field label="Job title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={100} /></Field>
          <Field label="Email" hint={user!.emailVerified ? '✓ Verified' : user!.needsEmailVerification ? 'Not yet confirmed. Use the banner above to resend the email.' : undefined}><Input value={user!.email} disabled /></Field>
          <ErrorBox error={save.error} />
          <Button type="submit" loading={save.isPending}>Save profile</Button>
        </form>
      </Card>
      <Card className="p-5">
        <h3 className="mb-4 font-semibold">Password</h3>
        {conns.data && !conns.data.hasPassword ? (
          <div className="space-y-3 text-sm text-slate-600">
            <p>You sign in with a connected account, so this account has no password. You can add one if you also want to sign in with your email.</p>
            <Button variant="secondary" loading={setPassword.isPending} onClick={() => setPassword.mutate()}>Email me a link to set a password</Button>
            {devLink && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Development mode: no email provider is configured, so use <a className="font-medium underline" href={devLink}>this link</a>.</p>}
          </div>
        ) : (
        <form onSubmit={(e) => { e.preventDefault(); change.mutate(); }} className="space-y-3">
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /></Field>
          <Field label="New password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required /></Field>
          <ErrorBox error={change.error} />
          <Button type="submit" loading={change.isPending}>Change password</Button>
        </form>
        )}
        <hr className="my-5" />
        <Button variant="secondary" onClick={() => api('/auth/logout-all', { method: 'POST', noWorkspace: true }).then(() => { useAuth.getState().clear(); location.href = '/login'; })}>Sign out of all devices</Button>
      </Card>
      <ConnectedAccounts conns={conns.data} />
    </div>
  );
}

function WorkspaceSettings() {
  const ws = useWorkspace()!;
  const qc = useQueryClient();
  const nav = useNavigate();
  const canManage = ['owner', 'admin'].includes(ws.role);
  const [name, setName] = useState(ws.name);
  const [confirm, setConfirm] = useState('');
  const rename = useMutation({
    mutationFn: () => patch(`/workspaces/${ws.id}`, { name }),
    onSuccess: () => { useAuth.getState().setWorkspaces(useAuth.getState().workspaces.map((w) => (w.id === ws.id ? { ...w, name } : w))); toast.success('Workspace renamed'); },
  });
  const remove = useMutation({
    mutationFn: () => api(`/workspaces/${ws.id}`, { method: 'DELETE', body: { confirmName: confirm } }),
    onSuccess: () => { useAuth.getState().setWorkspaces(useAuth.getState().workspaces.filter((w) => w.id !== ws.id)); qc.clear(); toast.success('Workspace deleted'); nav('/app'); },
  });
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h3 className="mb-4 font-semibold">Workspace</h3>
        <form onSubmit={(e) => { e.preventDefault(); rename.mutate(); }} className="flex max-w-lg items-end gap-3">
          <div className="flex-1"><Field label="Name"><Input value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field></div>
          <Button type="submit" disabled={!canManage || name === ws.name || !name.trim()} loading={rename.isPending}>Rename</Button>
        </form>
        <p className="mt-3 text-xs text-slate-400">Your role: <Badge>{ws.role}</Badge> · Plan: <Badge tone="brand">{ws.plan}</Badge></p>
      </Card>
      {ws.role === 'owner' && (
        <Card className="border-red-200 p-5">
          <h3 className="font-semibold text-red-700">Danger zone</h3>
          <p className="mt-1 text-sm text-slate-500">Permanently deletes every project, task, message, document and AI record in this workspace. This cannot be undone.</p>
          <div className="mt-4 flex max-w-lg items-end gap-3"><div className="flex-1"><Field label={`Type “${ws.name}” to confirm`}><Input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field></div><Button variant="danger" disabled={confirm !== ws.name} loading={remove.isPending} onClick={() => remove.mutate()}>Delete workspace</Button></div>
          <div className="mt-3"><ErrorBox error={remove.error} /></div>
        </Card>
      )}
    </div>
  );
}

function AuditLog() {
  const key = useWsKey();
  const [action, setAction] = useState('');
  const q = useQuery({ queryKey: key('audit', action), queryFn: () => get<any[]>(`/audit-logs${action ? `?action=${action}` : ''}`), retry: false });
  if (q.isLoading) return <Loading />;
  if (q.error) return <Card className="p-8 text-center"><p className="text-2xl">🔒</p><p className="mt-1 font-semibold">Audit logs</p><p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{(q.error as Error).message}</p><a href="/app/billing"><Button className="mt-4">See plans</Button></a></Card>;
  const actions = ['USER_INVITED', 'ROLE_CHANGED', 'MEMBER_REMOVED', 'PROJECT_CREATED', 'PROJECT_DELETED', 'TASK_CREATED', 'TASK_DELETED', 'DOCUMENT_UPLOADED', 'DOCUMENT_DELETED', 'SUBSCRIPTION_CHANGED', 'AI_TASKS_APPROVED'];
  return (
    <div>
      <div className="mb-3"><Select className="w-64" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter action"><option value="">All actions</option>{actions.map((a) => <option key={a}>{a}</option>)}</Select></div>
      <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2.5">When</th><th>Actor</th><th>Action</th><th>Target</th><th className="pr-4">Details</th></tr></thead>
        <tbody>{q.data?.map((l) => <tr key={l.id} className="border-b border-slate-50"><td className="whitespace-nowrap px-4 py-2 text-slate-500" title={new Date(l.createdAt).toLocaleString()}>{timeAgo(l.createdAt)}</td><td>{l.actor?.name || '—'}</td><td><Badge>{l.action}</Badge></td><td className="text-slate-500">{l.targetType}</td><td className="max-w-xs truncate pr-4 text-xs text-slate-400">{l.metadata ? JSON.stringify(l.metadata) : ''}</td></tr>)}</tbody></table>
        {!q.data?.length && <p className="p-6 text-center text-sm text-slate-400">No entries</p>}
      </Card>
      <p className="mt-2 text-xs text-slate-400">Showing the latest {q.data?.length} entries · {q.data?.[0] && fmtDate(q.data[0].createdAt, true)}</p>
    </div>
  );
}

export default function Settings() {
  const ws = useWorkspace()!;
  const [tab, setTab] = useState<'profile' | 'workspace' | 'audit'>('profile');
  const isAdmin = ['owner', 'admin'].includes(ws.role);
  const tabs = [{ id: 'profile', label: 'Account' }, { id: 'workspace', label: 'Workspace' }, ...(isAdmin ? [{ id: 'audit', label: 'Audit log' }] : [])] as { id: typeof tab; label: string }[];
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="mb-5 flex gap-1 border-b border-slate-200">{tabs.map((t) => <button key={t.id} onClick={() => setTab(t.id)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{t.label}</button>)}</div>
      {tab === 'profile' ? <Profile /> : tab === 'workspace' ? <WorkspaceSettings /> : <AuditLog />}
    </div>
  );
}
