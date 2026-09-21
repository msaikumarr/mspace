import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { get } from '../services/api';
import { useProjects, useWsKey } from '../hooks/useData';
import { Button, Card, Empty, Loading, PageHeader, Progress, Select, StatCard } from '../components/ui';
import { fmtDate, statusLabel } from '../utils';

const PRIORITY_COLORS: Record<string, string> = { LOW: '#94a3b8', MEDIUM: '#38bdf8', HIGH: '#f59e0b', URGENT: '#ef4444' };
const STATUS_COLORS: Record<string, string> = { BACKLOG: '#94a3b8', TODO: '#38bdf8', IN_PROGRESS: '#f59e0b', REVIEW: '#a855f7', DONE: '#10b981' };

const ChartCard = ({ title, children, sub }: { title: string; sub?: string; children: React.ReactNode }) => (
  <Card className="p-5"><h3 className="font-semibold text-slate-800">{title}</h3>{sub && <p className="text-xs text-slate-400">{sub}</p>}<div className="mt-4 h-64">{children}</div></Card>
);

export default function Analytics() {
  const key = useWsKey();
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const q = useQuery({ queryKey: key('analytics', projectId), queryFn: () => get<any>(`/analytics${projectId ? `?projectId=${projectId}` : ''}`) });
  const d = q.data;

  return (
    <div>
      <PageHeader title="Analytics" subtitle="Decision-support on work items — not a measure of anyone's worth." actions={
        <Select className="w-52" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project"><option value="">All projects</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      } />
      {q.isLoading || !d ? <Loading /> : d.totals.total === 0 ? <Empty icon="📊" title="No data yet" hint="Create some tasks and the charts will appear here." /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Total tasks" value={d.totals.total} />
            <StatCard label="Completed" value={d.totals.completed} tone="text-emerald-600" />
            <StatCard label="Pending" value={d.totals.pending} />
            <StatCard label="Overdue" value={d.totals.overdue} tone={d.totals.overdue ? 'text-red-600' : ''} />
            <StatCard label="Unassigned" value={d.totals.unassigned} sub="open tasks" />
            <StatCard label="Completion" value={`${d.totals.completionRate}%`} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title="Priority distribution">
              <ResponsiveContainer><PieChart><Pie data={d.priority.filter((x: any) => x.value)} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>{d.priority.filter((x: any) => x.value).map((x: any) => <Cell key={x.name} fill={PRIORITY_COLORS[x.name]} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Tasks by status">
              <ResponsiveContainer><BarChart data={d.status.map((x: any) => ({ ...x, label: statusLabel(x.name) }))}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="value" name="Tasks" radius={[4, 4, 0, 0]}>{d.status.map((x: any) => <Cell key={x.name} fill={STATUS_COLORS[x.name]} />)}</Bar></BarChart></ResponsiveContainer>
            </ChartCard>
          </div>

          {d.locked ? (
            <Card className="border-brand-200 bg-brand-50/60 p-6 text-center">
              <p className="text-2xl">🔒</p>
              <p className="mt-1 font-semibold text-slate-800">Advanced analytics is a Pro feature</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">Weekly throughput, member workload, team activity and per-project progress.</p>
              <a href="/app/billing"><Button className="mt-4">Upgrade</Button></a>
            </Card>
          ) : (
            <>
              <div className="grid gap-5 lg:grid-cols-2">
                <ChartCard title="Weekly task completion" sub="Last 8 weeks">
                  <ResponsiveContainer><BarChart data={d.weekly.map((w: any) => ({ ...w, label: fmtDate(w.week) }))}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="completed" name="Completed" fill="#6366f1" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>
                </ChartCard>
                <ChartCard title="Team activity" sub="Last 14 days">
                  <ResponsiveContainer><LineChart data={d.activity.map((a: any) => ({ ...a, label: fmtDate(a.date) }))}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 11 }} interval={1} /><YAxis allowDecimals={false} /><Tooltip /><Legend /><Line type="monotone" dataKey="created" name="Created" stroke="#0ea5e9" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="completed" name="Completed" stroke="#10b981" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer>
                </ChartCard>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <ChartCard title="Member workload" sub="Open vs. completed tasks — a capacity view">
                  {d.workload.length === 0 ? <p className="pt-20 text-center text-sm text-slate-400">No assigned tasks</p> : (
                    <ResponsiveContainer><BarChart data={d.workload} layout="vertical" margin={{ left: 20 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="name" width={90} tick={{ fontSize: 11 }} /><Tooltip /><Legend /><Bar dataKey="open" name="Open" stackId="a" fill="#f59e0b" /><Bar dataKey="done" name="Done" stackId="a" fill="#10b981" /></BarChart></ResponsiveContainer>
                  )}
                </ChartCard>
                {!projectId && (
                  <Card className="p-5"><h3 className="font-semibold text-slate-800">Project progress</h3>
                    <div className="mt-4 space-y-4">{d.projects.length === 0 && <p className="text-sm text-slate-400">No projects with tasks.</p>}{d.projects.map((p: any) => (
                      <div key={p.projectId}><div className="mb-1 flex justify-between text-sm"><span className="font-medium text-slate-700">{p.name}</span><span className="text-slate-500">{p.done}/{p.total} · {p.progress}%</span></div><Progress value={p.progress} /></div>
                    ))}</div>
                  </Card>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
