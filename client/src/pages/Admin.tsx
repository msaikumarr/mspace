import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { get } from '../services/api';
import { useAuth } from '../store/auth';
import { Badge, Card, Loading, PageHeader, StatCard } from '../components/ui';
import { fmtBytes, timeAgo } from '../utils';

export default function Admin() {
  const isAdmin = useAuth((s) => s.user?.isPlatformAdmin);
  const q = useQuery({ queryKey: ['admin-stats'], queryFn: () => get<any>('/admin/stats'), enabled: !!isAdmin, refetchInterval: 30_000 });
  if (!isAdmin) return <Navigate to="/app" replace />;
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  return (
    <div>
      <PageHeader title="Platform admin" subtitle="Cross-tenant metrics. Visible to platform administrators only." />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Organizations" value={d.organizations} />
        <StatCard label="Users" value={d.users} sub={`${d.activeUsers30d} active in 30d`} />
        <StatCard label="Projects" value={d.projects} sub={`${d.tasks} tasks`} />
        <StatCard label="AI requests" value={d.aiRequests.total} sub={`${d.aiRequests.last30d} in 30d`} />
        <StatCard label="Storage used" value={fmtBytes(d.storageBytes)} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5"><h3 className="font-semibold">Subscription distribution</h3>
          <div className="mt-4 h-56"><ResponsiveContainer><BarChart data={d.subscriptions}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="plan" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="count" name="Workspaces" fill="#6366f1" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
        </Card>
        <Card className="p-5"><h3 className="mb-3 font-semibold">Recent system activity</h3>
          <ul className="max-h-56 space-y-2 overflow-y-auto text-sm">{d.recentActivity.map((a: any) => <li key={a.id} className="flex items-center gap-2"><Badge>{a.action}</Badge><span className="min-w-0 flex-1 truncate text-slate-500">{a.actor || 'system'} · {a.workspace || '—'}</span><span className="text-xs text-slate-400">{timeAgo(a.at)}</span></li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
