import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../services/api';
import { useMembers, useWsKey } from '../hooks/useData';
import { useAuth, useWorkspace } from '../store/auth';
import { Avatar, Badge, Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, toast } from '../components/ui';
import { ROLES, type Role } from '../types';
import { timeAgo } from '../utils';

const RANK: Role[] = ['owner', 'admin', 'manager', 'member', 'viewer'];
const DESC: Record<Role, string> = { owner: 'Full control', admin: 'Manage workspace & billing', manager: 'Create projects, invite', member: 'Create & edit tasks', viewer: 'Read-only' };

export default function Members() {
  const ws = useWorkspace()!;
  const me = useAuth((s) => s.user)!;
  const qc = useQueryClient();
  const key = useWsKey();
  const { members, isLoading } = useMembers();
  const myRank = RANK.indexOf(ws.role);
  const canInvite = myRank <= 2;
  const canManage = myRank <= 1;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const invites = useQuery({ queryKey: key('invites'), queryFn: () => get<{ id: string; email: string; role: Role }[]>(`/workspaces/${ws.id}/invites`), enabled: canInvite });
  const refresh = () => { qc.invalidateQueries({ queryKey: key('members') }); qc.invalidateQueries({ queryKey: key('invites') }); qc.invalidateQueries({ queryKey: key('billing') }); };
  const invite = useMutation({
    mutationFn: () => post<{ status: string }>(`/workspaces/${ws.id}/invites`, { email, role }),
    onSuccess: (r) => { toast.success(r.status === 'added' ? 'Member added' : 'Invite saved. They\'ll join once they sign up and confirm their email.'); setEmail(''); refresh(); },
  });
  const changeRole = useMutation({ mutationFn: ({ id, role }: { id: string; role: Role }) => patch(`/workspaces/${ws.id}/members/${id}`, { role }), onSuccess: () => { toast.success('Role updated'); refresh(); }, onError: toast.error });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/workspaces/${ws.id}/members/${id}`),
    onSuccess: (_d, id) => { refresh(); if (id === me.id) { useAuth.getState().setWorkspaces(useAuth.getState().workspaces.filter((w) => w.id !== ws.id)); qc.clear(); } },
    onError: toast.error,
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/workspaces/${ws.id}/invites/${id}`), onSuccess: refresh, onError: toast.error });
  const allowedRoles = ROLES.filter((r) => r !== 'owner' && (ws.role === 'owner' || RANK.indexOf(r) > myRank));

  return (
    <div>
      <PageHeader title="Members" subtitle={`${members.length} people in ${ws.name}`} />
      {canInvite && (
        <Card className="mb-6 p-5">
          <h3 className="mb-3 text-sm font-semibold">Invite someone</h3>
          <form onSubmit={(e) => { e.preventDefault(); invite.mutate(); }} className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1"><Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" /></Field></div>
            <div className="w-56"><Field label="Role" hint={DESC[role]}><Select value={role} onChange={(e) => setRole(e.target.value as Role)}>{allowedRoles.map((r) => <option key={r} value={r}>{r}</option>)}</Select></Field></div>
            <Button type="submit" loading={invite.isPending}>Send invite</Button>
          </form>
          <div className="mt-3"><ErrorBox error={invite.error} /></div>
        </Card>
      )}
      {isLoading ? <Loading /> : (
        <Card className="divide-y divide-slate-100">
          {members.map((m) => {
            const isMe = m.user.id === me.id;
            const canEditThis = canManage && m.role !== 'owner' && !isMe && RANK.indexOf(m.role) > myRank;
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar name={m.user.name} color={m.user.avatarColor} size={36} />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-slate-800">{m.user.name} {isMe && <span className="text-xs text-slate-400">(you)</span>}</p><p className="truncate text-xs text-slate-400">{m.user.email}{m.user.lastActiveAt && ` · active ${timeAgo(m.user.lastActiveAt)}`}</p></div>
                {canEditThis ? (
                  <Select className="w-32 py-1" value={m.role} onChange={(e) => changeRole.mutate({ id: m.user.id, role: e.target.value as Role })} aria-label={`Role for ${m.user.name}`}>{allowedRoles.map((r) => <option key={r}>{r}</option>)}</Select>
                ) : <Badge tone={m.role === 'owner' ? 'purple' : 'slate'}>{m.role}</Badge>}
                {(canEditThis || (isMe && m.role !== 'owner')) && <Button size="sm" variant="ghost" onClick={() => confirm(isMe ? 'Leave this workspace?' : `Remove ${m.user.name}?`) && remove.mutate(m.user.id)}>{isMe ? 'Leave' : 'Remove'}</Button>}
              </div>
            );
          })}
        </Card>
      )}
      {!!invites.data?.length && (
        <div className="mt-6"><h3 className="mb-2 text-sm font-semibold text-slate-600">Pending invitations</h3>
          <Card className="divide-y divide-slate-100">{invites.data.map((i) => (
            <div key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm"><span className="flex-1">{i.email}</span><Badge>{i.role}</Badge><Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button></div>
          ))}</Card>
        </div>
      )}
      <Card className="mt-6 p-5">
        <h3 className="mb-3 text-sm font-semibold">Roles</h3>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">{ROLES.map((r) => <div key={r} className="flex gap-2"><dt className="w-20 font-medium capitalize text-slate-700">{r}</dt><dd className="text-slate-500">{DESC[r]}</dd></div>)}</dl>
      </Card>
    </div>
  );
}
