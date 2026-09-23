import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, Target } from 'lucide-react';
import { get } from '../services/api';
import { useProjects, useTasks, useWsKey } from '../hooks/useData';
import { useAuth, useRoleAtLeast, useWorkspace } from '../store/auth';
import { Badge, Button, Card, Empty, Loading, PageHeader, Progress, StatCard, priorityTone } from '../components/ui';
import { fmtDate, isOverdue, statusLabel } from '../utils';

export default function Overview() {
  const user = useAuth((s) => s.user)!;
  const ws = useWorkspace()!;
  const key = useWsKey();
  const canCreateProject = useRoleAtLeast('manager');
  const projects = useProjects();
  const mine = useTasks({ assigneeId: 'me' });
  const stats = useQuery({ queryKey: key('analytics', ''), queryFn: () => get<any>('/analytics') });
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const open = (mine.data || []).filter((t) => t.status !== 'DONE');
  const rank = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>;
  const focus = [...open].sort((a, b) => rank[a.priority] - rank[b.priority] || (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity)).slice(0, 6);

  if (projects.isLoading || stats.isLoading) return <Loading />;
  const t = stats.data?.totals;

  return (
    <div>
      <PageHeader title={`${greet}, ${user.name.split(' ')[0]}`} subtitle={`Here's what's happening in ${ws.name}.`} />
      {!projects.data?.length && (
        <Card className="mb-6 border-brand-200 bg-brand-50/60 p-6">
          <h2 className="font-semibold text-slate-900">Get started in three steps</h2>
          <ol className="mt-3 space-y-1.5 text-sm text-slate-600">
            <li>1. <Link className="font-medium text-brand-600" to="/app/members">Invite your team</Link></li>
            <li>2. <Link className="font-medium text-brand-600" to="/app/projects">Create a project</Link> and add tasks</li>
            <li>3. <Link className="font-medium text-brand-600" to="/app/documents">Upload a document</Link> and ask the <Link className="font-medium text-brand-600" to="/app/copilot">Copilot</Link> about it</li>
          </ol>
          {canCreateProject && <Link to="/app/projects"><Button className="mt-4">Create your first project</Button></Link>}
        </Card>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open tasks" value={t?.pending ?? 0} />
        <StatCard label="Completed" value={t?.completed ?? 0} tone="text-emerald-600" sub={`${t?.completionRate ?? 0}% completion`} />
        <StatCard label="Overdue" value={t?.overdue ?? 0} tone={t?.overdue ? 'text-red-600' : ''} />
        <StatCard label="Assigned to you" value={open.length} />
      </div>
      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-3">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Your focus</h2><Link to="/app/copilot" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline">Ask Copilot <Sparkles className="h-3.5 w-3.5" /></Link></div>
          {focus.length === 0 ? <Empty icon={Target} title="Nothing assigned to you" hint="Tasks assigned to you appear here, sorted by priority and due date." /> : (
            <ul className="divide-y divide-slate-100">
              {focus.map((task) => (
                <li key={task.id}><Link to={`/app/projects/${task.projectId}?task=${task.id}`} className="flex items-center gap-3 py-2.5 hover:bg-slate-50">
                  <Badge tone={priorityTone(task.priority) as any}>{task.priority}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{task.title}</span>
                  <Badge>{statusLabel(task.status)}</Badge>
                  {task.dueDate && <span className={`text-xs ${isOverdue(task.dueDate, task.status) ? 'font-semibold text-red-600' : 'text-slate-400'}`}>{fmtDate(task.dueDate)}</span>}
                </Link></li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Projects</h2><Link to="/app/projects" className="text-sm text-brand-600 hover:underline">View all</Link></div>
          <div className="space-y-4">
            {projects.data?.slice(0, 5).map((p) => {
              const pct = p.taskCount ? Math.round(((p.doneCount || 0) / p.taskCount) * 100) : 0;
              return <Link key={p.id} to={`/app/projects/${p.id}`} className="block"><div className="mb-1 flex justify-between text-sm"><span className="flex items-center gap-2 font-medium text-slate-700"><span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />{p.name}</span><span className="text-xs text-slate-400">{pct}%</span></div><Progress value={pct} /></Link>;
            })}
            {!projects.data?.length && <p className="text-sm text-slate-400">No projects yet.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
