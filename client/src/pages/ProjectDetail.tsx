import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Sparkles, FolderX } from 'lucide-react';
import { del, get, patch } from '../services/api';
import { useMembers, useTasks, useWsKey } from '../hooks/useData';
import { useRoleAtLeast } from '../store/auth';
import TaskDrawer, { NewTaskModal } from '../components/TaskDrawer';
import { Avatar, Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Progress, Select, Tabs, Textarea, priorityTone, toast } from '../components/ui';
import { PRIORITIES, STATUSES, type Project, type Status, type Task } from '../types';
import { cn, fmtDate, isOverdue, statusLabel, toDateInput } from '../utils';
import DocumentsPanel from './Documents';

const COL_TONE: Record<Status, string> = { BACKLOG: 'bg-slate-400', TODO: 'bg-sky-500', IN_PROGRESS: 'bg-amber-500', REVIEW: 'bg-purple-500', DONE: 'bg-emerald-500' };

function TaskCard({ t, byId, canDrag, onOpen, onDragStart, onDragOverCard }: any) {
  const a = t.assigneeId ? byId.get(t.assigneeId) : null;
  const overdue = isOverdue(t.dueDate, t.status);
  return (
    <div
      draggable={canDrag}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; onDragStart(t.id); }}
      onDragOver={(e) => { e.preventDefault(); onDragOverCard(t.id); }}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      tabIndex={0}
      role="button"
      aria-label={`Task ${t.title}`}
      className={cn('cursor-pointer rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition hover:border-brand-300 hover:shadow', canDrag && 'active:cursor-grabbing')}
    >
      <p className="text-sm font-medium text-slate-800">{t.title}</p>
      {t.labels.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{t.labels.map((l: string) => <Badge key={l} tone={/block/i.test(l) ? 'red' : 'slate'}>{l}</Badge>)}</div>}
      <div className="mt-2.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5"><Badge tone={priorityTone(t.priority) as any}>{t.priority}</Badge>{t.source !== 'manual' && <span title={t.source === 'ai' ? 'AI-suggested' : 'From meeting'}><Sparkles className="h-3.5 w-3.5 text-brand-500" /></span>}</div>
        <div className="flex items-center gap-2">
          {t.dueDate && <span className={cn('text-[11px]', overdue ? 'font-semibold text-red-600' : 'text-slate-400')}>{overdue ? 'Overdue · ' : ''}{fmtDate(t.dueDate)}</span>}
          {a && <Avatar name={a.name} color={a.avatarColor} size={22} />}
        </div>
      </div>
    </div>
  );
}

function Board({ tasks, onOpen, onAdd }: { tasks: Task[]; onOpen: (id: string) => void; onAdd: (s: Status) => void }) {
  const qc = useQueryClient();
  const key = useWsKey();
  const { byId } = useMembers();
  const canEdit = useRoleAtLeast('member');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<Status | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: ({ id, status, position }: { id: string; status: Status; position: number }) => patch(`/tasks/${id}`, { status, position }),
    onError: (e) => { toast.error(e); qc.invalidateQueries({ queryKey: ['ws'] }); },
    onSettled: () => qc.invalidateQueries({ queryKey: key('analytics') }),
  });

  const cols = useMemo(() => Object.fromEntries(STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).sort((a, b) => a.position - b.position)])) as Record<Status, Task[]>, [tasks]);

  const drop = (status: Status) => {
    if (!dragId || !canEdit) return;
    const list = cols[status].filter((t) => t.id !== dragId);
    const idx = overCard ? list.findIndex((t) => t.id === overCard) : -1;
    const before = idx > 0 ? list[idx - 1].position : idx === 0 ? list[0].position - 2000 : (list.at(-1)?.position ?? 0);
    const after = idx >= 0 ? list[idx].position : before + 2000;
    const position = idx >= 0 ? (before + after) / 2 : before + 1000;
    // optimistic update, rolled back by the invalidate in onError
    qc.setQueriesData<Task[]>({ queryKey: key('tasks') }, (old) => old?.map((t) => (t.id === dragId ? { ...t, status, position } : t)));
    move.mutate({ id: dragId, status, position });
    setDragId(null); setOverCol(null); setOverCard(null);
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {STATUSES.map((s) => (
        <section
          key={s}
          aria-label={statusLabel(s)}
          onDragOver={(e) => { e.preventDefault(); setOverCol(s); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol(null); }}
          onDrop={(e) => { e.preventDefault(); drop(s); }}
          className={cn('flex w-72 shrink-0 flex-col rounded-xl bg-slate-100/80 p-2.5', overCol === s && dragId && 'ring-2 ring-brand-300')}
        >
          <div className="mb-2 flex items-center justify-between px-1">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-600"><span className={cn('h-2 w-2 rounded-full', COL_TONE[s])} />{statusLabel(s)}<span className="rounded-full bg-white px-1.5 text-[11px] text-slate-500">{cols[s].length}</span></h3>
            {canEdit && <button onClick={() => onAdd(s)} className="rounded p-1 text-slate-400 hover:bg-white hover:text-brand-600" aria-label={`Add task to ${statusLabel(s)}`}><Plus className="h-4 w-4" /></button>}
          </div>
          <div className="min-h-[60px] flex-1 space-y-2">
            {cols[s].map((t) => <TaskCard key={t.id} t={t} byId={byId} canDrag={canEdit} onOpen={() => onOpen(t.id)} onDragStart={setDragId} onDragOverCard={setOverCard} />)}
            {cols[s].length === 0 && <p className="py-4 text-center text-xs text-slate-400">{canEdit ? 'Drop tasks here' : 'No tasks'}</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function ListView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const { byId } = useMembers();
  if (!tasks.length) return <Empty title="No tasks match" hint="Try clearing filters or add a task." icon={Search} />;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2.5">Task</th><th>Status</th><th>Priority</th><th>Assignee</th><th className="pr-4">Due</th></tr></thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} onClick={() => onOpen(t.id)} className="cursor-pointer border-b border-slate-50 hover:bg-slate-50">
              <td className="px-4 py-2.5 font-medium text-slate-800">{t.title}</td>
              <td><Badge>{statusLabel(t.status)}</Badge></td>
              <td><Badge tone={priorityTone(t.priority) as any}>{t.priority}</Badge></td>
              <td>{t.assigneeId ? byId.get(t.assigneeId)?.name : <span className="text-slate-400">—</span>}</td>
              <td className={cn('pr-4', isOverdue(t.dueDate, t.status) && 'font-semibold text-red-600')}>{fmtDate(t.dueDate) || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function EditProject({ p, open, onClose }: { p: Project; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const canDelete = useRoleAtLeast('admin');
  const [f, setF] = useState({ name: p.name, description: p.description, status: p.status, deadline: toDateInput(p.deadline) });
  const save = useMutation({
    mutationFn: () => patch(`/projects/${p.id}`, { ...f, deadline: f.deadline ? new Date(f.deadline).toISOString() : null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ws'] }); toast.success('Project updated'); onClose(); },
  });
  const remove = useMutation({
    mutationFn: () => del(`/projects/${p.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ws'] }); nav('/app/projects'); toast.success('Project deleted'); },
    onError: toast.error,
  });
  return (
    <Modal open={open} onClose={onClose} title="Edit project">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Project['status'] })}>{['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select></Field>
          <Field label="Deadline"><Input type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></Field>
        </div>
        <ErrorBox error={save.error} />
        <div className="flex items-center justify-between pt-1">
          {canDelete ? <Button type="button" variant="danger" size="sm" loading={remove.isPending} onClick={() => confirm(`Delete "${p.name}" and all its tasks?`) && remove.mutate()}>Delete project</Button> : <span />}
          <div className="flex gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></div>
        </div>
      </form>
    </Modal>
  );
}

export default function ProjectDetail() {
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const key = useWsKey();
  const canCreate = useRoleAtLeast('member');
  const canEditProject = useRoleAtLeast('manager');
  const { members } = useMembers();
  const [tab, setTab] = useState<'board' | 'list' | 'files'>('board');
  const [creating, setCreating] = useState<Status | null>(null);
  const [editing, setEditing] = useState(false);
  const [filters, setFilters] = useState({ q: '', assignee: '', priority: '' });
  const project = useQuery({ queryKey: key('project', id), queryFn: () => get<Project>(`/projects/${id}`) });
  const tasks = useTasks({ projectId: id });
  const openId = sp.get('task');

  const filtered = useMemo(() => (tasks.data || []).filter((t) =>
    (!filters.q || t.title.toLowerCase().includes(filters.q.toLowerCase())) &&
    (!filters.assignee || (filters.assignee === 'none' ? !t.assigneeId : t.assigneeId === filters.assignee)) &&
    (!filters.priority || t.priority === filters.priority)), [tasks.data, filters]);

  if (project.isLoading) return <Loading />;
  if (project.error || !project.data) return <Empty title="Project not found" hint="It may have been deleted, or you may not have access." icon={FolderX} action={<Link to="/app/projects"><Button variant="secondary">Back to projects</Button></Link>} />;
  const p = project.data;
  const total = tasks.data?.length || 0;
  const done = tasks.data?.filter((t) => t.status === 'DONE').length || 0;

  return (
    <div>
      <div className="mb-1 text-sm text-slate-400"><Link to="/app/projects" className="hover:text-brand-600">Projects</Link> / {p.name}</div>
      <PageHeader
        title={p.name}
        subtitle={p.description || undefined}
        actions={<>
          {canEditProject && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
          {canCreate && <Button onClick={() => setCreating('TODO')}><Plus className="h-4 w-4" /> New task</Button>}
        </>}
      />
      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-500">
        <Badge tone="brand">{statusLabel(p.status)}</Badge>
        {p.deadline && <span>Deadline <b className="text-slate-700">{fmtDate(p.deadline, true)}</b></span>}
        <div className="flex w-56 items-center gap-2"><Progress value={total ? (done / total) * 100 : 0} /><span className="text-xs">{done}/{total}</span></div>
      </div>

      <Tabs tabs={[{ id: 'board', label: 'Kanban board' }, { id: 'list', label: 'List' }, { id: 'files', label: 'Files' }]} value={tab} onChange={setTab} />

      {tab !== 'files' && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Input className="max-w-52" placeholder="Search tasks…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} aria-label="Search tasks" />
          <Select className="max-w-44" value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })} aria-label="Filter by assignee"><option value="">All assignees</option><option value="none">Unassigned</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}</Select>
          <Select className="max-w-40" value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })} aria-label="Filter by priority"><option value="">All priorities</option>{PRIORITIES.map((x) => <option key={x}>{x}</option>)}</Select>
        </div>
      )}

      {tasks.isLoading ? <Loading /> : tab === 'board' ? (
        <Board tasks={filtered} onOpen={(tid) => setSp({ task: tid })} onAdd={setCreating} />
      ) : tab === 'list' ? (
        <ListView tasks={filtered} onOpen={(tid) => setSp({ task: tid })} />
      ) : (
        <DocumentsPanel projectId={id} />
      )}

      <NewTaskModal projectId={id} open={!!creating} defaultStatus={creating || undefined} onClose={() => setCreating(null)} />
      <TaskDrawer taskId={openId} onClose={() => setSp({})} />
      {editing && <EditProject p={p} open onClose={() => setEditing(false)} />}
    </div>
  );
}
