import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../services/api';
import { useMembers, useWsKey, useProjects } from '../hooks/useData';
import { useRoleAtLeast } from '../store/auth';
import { Avatar, Badge, Button, ErrorBox, Field, Input, Loading, Modal, Select, Textarea, priorityTone, toast } from './ui';
import { PRIORITIES, STATUSES, type Comment, type Task } from '../types';
import { fmtDate, statusLabel, timeAgo, toDateInput } from '../utils';

export function NewTaskModal({ projectId, open, onClose, defaultStatus }: { projectId?: string; open: boolean; onClose: () => void; defaultStatus?: string }) {
  const qc = useQueryClient();
  const { members } = useMembers();
  const projects = useProjects();
  const [f, setF] = useState({ projectId: projectId || '', title: '', description: '', priority: 'MEDIUM', status: defaultStatus || 'TODO', assigneeId: '', dueDate: '' });
  useEffect(() => { if (open) setF((p) => ({ ...p, projectId: projectId || p.projectId || projects.data?.[0]?.id || '', status: defaultStatus || 'TODO' })); }, [open, projectId, defaultStatus, projects.data]);
  const m = useMutation({
    mutationFn: () => post('/tasks', { ...f, assigneeId: f.assigneeId || null, dueDate: f.dueDate ? new Date(f.dueDate).toISOString() : null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ws'] }); toast.success('Task created'); setF((p) => ({ ...p, title: '', description: '', assigneeId: '', dueDate: '' })); onClose(); },
  });
  const set = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} title="New task">
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-3">
        {!projectId && (
          <Field label="Project"><Select value={f.projectId} onChange={set('projectId')} required>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        )}
        <Field label="Title"><Input autoFocus required maxLength={200} value={f.title} onChange={set('title')} placeholder="What needs to be done?" /></Field>
        <Field label="Description"><Textarea rows={3} value={f.description} onChange={set('description')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority"><Select value={f.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</Select></Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')}>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select></Field>
          <Field label="Assignee"><Select value={f.assigneeId} onChange={set('assigneeId')}><option value="">Unassigned</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}</Select></Field>
          <Field label="Due date"><Input type="date" value={f.dueDate} onChange={set('dueDate')} /></Field>
        </div>
        <ErrorBox error={m.error} />
        <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending} disabled={!f.projectId}>Create task</Button></div>
      </form>
    </Modal>
  );
}

export default function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const key = useWsKey();
  const canEdit = useRoleAtLeast('member');
  const canDelete = useRoleAtLeast('manager');
  const { members, byId } = useMembers();
  const task = useQuery({ queryKey: key('task', taskId), queryFn: () => get<Task>(`/tasks/${taskId}`), enabled: !!taskId });
  const comments = useQuery({ queryKey: key('comments', taskId), queryFn: () => get<Comment[]>(`/tasks/${taskId}/comments`), enabled: !!taskId });
  const [draft, setDraft] = useState<Partial<Task> & { label?: string }>({});
  const [text, setText] = useState('');
  useEffect(() => setDraft({}), [taskId, task.data?.updatedAt]);
  const t = task.data ? { ...task.data, ...draft } : null;

  const save = useMutation({
    mutationFn: (p: Partial<Task>) => patch<Task>(`/tasks/${taskId}`, p),
    onSuccess: (d) => { qc.setQueryData(key('task', taskId), d); qc.invalidateQueries({ queryKey: ['ws'] }); },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: () => del(`/tasks/${taskId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ws'] }); toast.success('Task deleted'); onClose(); },
    onError: toast.error,
  });
  const comment = useMutation({
    mutationFn: () => {
      const mentions = members.filter((m) => new RegExp(`@${m.user.name.split(' ')[0]}\\b`, 'i').test(text)).map((m) => m.user.id);
      return post(`/tasks/${taskId}/comments`, { text, mentions });
    },
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: key('comments', taskId) }); },
    onError: toast.error,
  });
  const commit = (p: Partial<Task>) => save.mutate(p);

  return (
    <Modal open={!!taskId} onClose={onClose} title="Task" wide>
      {!t ? <Loading /> : (
        <div className="grid gap-6 md:grid-cols-[1fr_260px]">
          <div className="min-w-0 space-y-4">
            <Input disabled={!canEdit} className="text-base font-semibold" value={t.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} onBlur={() => draft.title !== undefined && draft.title.trim() && commit({ title: draft.title })} aria-label="Title" />
            <Field label="Description">
              <Textarea disabled={!canEdit} rows={5} value={t.description} placeholder="Add more detail…" onChange={(e) => setDraft({ ...draft, description: e.target.value })} onBlur={() => draft.description !== undefined && commit({ description: draft.description })} />
            </Field>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Comments</h3>
              <div className="max-h-64 space-y-3 overflow-y-auto">
                {comments.data?.length === 0 && <p className="text-sm text-slate-400">No comments yet.</p>}
                {comments.data?.map((c) => (
                  <div key={c.id} className="flex gap-2.5">
                    <Avatar name={c.user?.name} color={c.user?.avatarColor} size={26} />
                    <div className="min-w-0 flex-1 rounded-lg bg-slate-50 px-3 py-2">
                      <p className="text-xs"><span className="font-semibold text-slate-700">{c.user?.name}</span> <span className="text-slate-400">{timeAgo(c.createdAt)}</span></p>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-700">{c.text}</p>
                    </div>
                  </div>
                ))}
              </div>
              {canEdit && (
                <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) comment.mutate(); }} className="mt-3 flex gap-2">
                  <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment… use @Name to mention" maxLength={5000} />
                  <Button type="submit" loading={comment.isPending} disabled={!text.trim()}>Send</Button>
                </form>
              )}
            </div>
            {t.activity?.length > 0 && (
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer font-medium">Activity ({t.activity.length})</summary>
                <ul className="mt-2 space-y-1">{[...t.activity].reverse().map((a, i) => <li key={i}><b className="font-medium text-slate-600">{byId.get(a.userId)?.name || 'Someone'}</b> {a.action} · {timeAgo(a.at)}</li>)}</ul>
              </details>
            )}
          </div>
          <aside className="space-y-3">
            <Field label="Status"><Select disabled={!canEdit} value={t.status} onChange={(e) => commit({ status: e.target.value as Task['status'] })}>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select></Field>
            <Field label="Priority"><Select disabled={!canEdit} value={t.priority} onChange={(e) => commit({ priority: e.target.value as Task['priority'] })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</Select></Field>
            <Field label="Assignee">
              <Select disabled={!canEdit} value={t.assigneeId || ''} onChange={(e) => commit({ assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
              </Select>
            </Field>
            <Field label="Due date"><Input disabled={!canEdit} type="date" value={toDateInput(t.dueDate)} onChange={(e) => commit({ dueDate: e.target.value ? new Date(e.target.value).toISOString() : null })} /></Field>
            <Field label="Labels" hint="Comma separated. Use “blocked” to flag blockers.">
              <Input disabled={!canEdit} defaultValue={t.labels.join(', ')} key={t.updatedAt} onBlur={(e) => { const labels = e.target.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10); if (labels.join() !== t.labels.join()) commit({ labels }); }} />
            </Field>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
              <Badge tone={priorityTone(t.priority) as any}>{t.priority}</Badge>
              {t.source !== 'manual' && <Badge tone="purple">{t.source === 'ai' ? 'AI-suggested' : 'From meeting'}</Badge>}
              <span>Created {fmtDate(t.createdAt, true)} by {byId.get(t.createdBy)?.name || 'someone'}</span>
            </div>
            {canDelete && <Button variant="danger" size="sm" className="w-full" loading={remove.isPending} onClick={() => confirm('Delete this task permanently?') && remove.mutate()}>Delete task</Button>}
          </aside>
        </div>
      )}
    </Modal>
  );
}
