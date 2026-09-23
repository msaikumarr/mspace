import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Plus } from 'lucide-react';
import { post } from '../services/api';
import { useProjects } from '../hooks/useData';
import { useRoleAtLeast } from '../store/auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Progress, Textarea, toast } from '../components/ui';
import { fmtDate, statusLabel } from '../utils';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

export default function Projects() {
  const projects = useProjects();
  const canCreate = useRoleAtLeast('manager');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', description: '', deadline: '', color: COLORS[0] });
  const create = useMutation({
    mutationFn: () => post('/projects', { ...f, deadline: f.deadline ? new Date(f.deadline).toISOString() : null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ws'] }); setOpen(false); setF({ name: '', description: '', deadline: '', color: COLORS[0] }); toast.success('Project created'); },
  });

  return (
    <div>
      <PageHeader title="Projects" subtitle="Every task, file and conversation lives inside a project." actions={canCreate && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New project</Button>} />
      {projects.isLoading ? <Loading /> : !projects.data?.length ? (
        <Empty title="No projects yet" icon={FolderOpen} hint={canCreate ? 'Create your first project to start planning work.' : 'A manager or admin needs to create a project.'} action={canCreate && <Button onClick={() => setOpen(true)}>Create project</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((p) => {
            const pct = p.taskCount ? Math.round(((p.doneCount || 0) / p.taskCount) * 100) : 0;
            return (
              <Link key={p.id} to={`/app/projects/${p.id}`}>
                <Card className="h-full p-5 transition hover:border-brand-300 hover:shadow-md">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5"><span className="h-3 w-3 rounded-full" style={{ background: p.color }} /><h3 className="font-semibold text-slate-900">{p.name}</h3></div>
                    <Badge tone={p.status === 'COMPLETED' ? 'green' : p.status === 'ON_HOLD' ? 'amber' : 'brand'}>{statusLabel(p.status)}</Badge>
                  </div>
                  <p className="mt-2 line-clamp-2 min-h-10 text-sm text-slate-500">{p.description || 'No description'}</p>
                  <div className="mt-4"><Progress value={pct} /><div className="mt-1.5 flex justify-between text-xs text-slate-500"><span>{p.doneCount || 0}/{p.taskCount || 0} tasks done</span>{p.deadline && <span>Due {fmtDate(p.deadline)}</span>}</div></div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New project">
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-3">
          <Field label="Name"><Input autoFocus required maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="Deadline"><Input type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></Field>
          <div className="flex gap-2" role="radiogroup" aria-label="Color">{COLORS.map((c) => <button type="button" key={c} role="radio" aria-checked={f.color === c} onClick={() => setF({ ...f, color: c })} className={`h-6 w-6 rounded-full ring-offset-2 ${f.color === c ? 'ring-2 ring-slate-800' : ''}`} style={{ background: c }} aria-label={c} />)}</div>
          <ErrorBox error={create.error} />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={create.isPending}>Create</Button></div>
        </form>
      </Modal>
    </div>
  );
}
