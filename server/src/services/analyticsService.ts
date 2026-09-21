import { Types } from 'mongoose';
import { Task, Project } from '../models/Project';
import { Member } from '../models/Workspace';
import { cache } from '../config/cache';

const DAY = 24 * 3600 * 1000;

function weekStart(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); // Monday
  return x;
}

export async function computeAnalytics(workspaceId: Types.ObjectId, projectId?: Types.ObjectId) {
  const key = `analytics:${workspaceId}:${projectId || 'all'}`;
  const hit = await cache.get<any>(key);
  if (hit) return hit;

  const match: Record<string, unknown> = { workspaceId };
  if (projectId) match.projectId = projectId;
  const now = new Date();
  const since8w = new Date(weekStart(now).getTime() - 7 * 7 * DAY);
  const since14d = new Date(now.getTime() - 13 * DAY);

  const [totals, byPriority, byStatus, byAssignee, weekly, daily, byProject] = await Promise.all([
    Task.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } },
          overdue: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'DONE'] }, { $eq: [{ $type: '$dueDate' }, 'date'] }, { $lt: ['$dueDate', now] }] }, 1, 0] } },
          unassigned: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'DONE'] }, { $eq: ['$assigneeId', null] }] }, 1, 0] } },
        },
      },
    ]),
    Task.aggregate([{ $match: match }, { $group: { _id: '$priority', n: { $sum: 1 } } }]),
    Task.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Task.aggregate([
      { $match: { ...match, assigneeId: { $ne: null } } },
      { $group: { _id: '$assigneeId', total: { $sum: 1 }, open: { $sum: { $cond: [{ $ne: ['$status', 'DONE'] }, 1, 0] } }, done: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } } } },
    ]),
    Task.aggregate([{ $match: { ...match, status: 'DONE', completedAt: { $gte: since8w } } }, { $group: { _id: { $dateTrunc: { date: '$completedAt', unit: 'week', startOfWeek: 'monday' } }, n: { $sum: 1 } } }]),
    Task.aggregate([
      { $match: { ...match, $or: [{ createdAt: { $gte: since14d } }, { completedAt: { $gte: since14d } }] } },
      { $project: { c: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, d: { $cond: [{ $ifNull: ['$completedAt', false] }, { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } }, null] } } },
    ]),
    projectId
      ? Promise.resolve([])
      : Task.aggregate([{ $match: match }, { $group: { _id: '$projectId', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } } } }]),
  ]);

  const t = totals[0] || { total: 0, completed: 0, overdue: 0, unassigned: 0 };
  const members = await Member.find({ workspaceId }).populate('userId', 'name avatarColor');
  const memberMap = new Map(members.filter((m) => m.userId).map((m) => [String((m.userId as any)._id), (m.userId as any).name as string]));

  const weeks: { week: string; completed: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const w = new Date(weekStart(now).getTime() - i * 7 * DAY);
    const found = weekly.find((x) => new Date(x._id).getTime() === w.getTime());
    weeks.push({ week: w.toISOString().slice(0, 10), completed: found?.n || 0 });
  }
  const days: { date: string; created: number; completed: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(now.getTime() - i * DAY).toISOString().slice(0, 10);
    days.push({ date, created: daily.filter((x) => x.c === date).length, completed: daily.filter((x) => x.d === date).length });
  }
  const projects = projectId ? [] : await Project.find({ workspaceId }).select('name color');
  const pn = new Map(projects.map((p) => [String(p._id), p]));

  const result = {
    totals: {
      total: t.total,
      completed: t.completed,
      pending: t.total - t.completed,
      overdue: t.overdue,
      unassigned: t.unassigned,
      completionRate: t.total ? Math.round((t.completed / t.total) * 100) : 0,
    },
    priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => ({ name: p, value: byPriority.find((x) => x._id === p)?.n || 0 })),
    status: ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'].map((s) => ({ name: s, value: byStatus.find((x) => x._id === s)?.n || 0 })),
    workload: byAssignee
      .map((a) => ({ userId: String(a._id), name: memberMap.get(String(a._id)) || 'Former member', open: a.open, done: a.done, total: a.total }))
      .sort((a, b) => b.open - a.open),
    weekly: weeks,
    activity: days,
    projects: byProject.map((p) => ({ projectId: String(p._id), name: pn.get(String(p._id))?.name || 'Deleted project', color: pn.get(String(p._id))?.color, total: p.total, done: p.done, progress: p.total ? Math.round((p.done / p.total) * 100) : 0 })),
  };
  await cache.set(key, result, 60);
  return result;
}

/** Rule-based, explainable insights. Deliberately about work items, not about ranking people. */
export async function computeInsights(workspaceId: Types.ObjectId, projectId?: Types.ObjectId) {
  const match: Record<string, unknown> = { workspaceId, status: { $ne: 'DONE' } };
  if (projectId) match.projectId = projectId;
  const now = new Date();
  const open = await Task.find(match).limit(1000);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < now);
  const highOpen = open.filter((t) => t.priority === 'HIGH' || t.priority === 'URGENT');
  const blocked = open.filter((t) => t.labels.some((l) => /block/i.test(l)));
  const stale = open.filter((t) => t.status === 'IN_PROGRESS' && now.getTime() - (t as any).updatedAt.getTime() > 7 * DAY);
  const unassigned = open.filter((t) => !t.assigneeId && (t.priority === 'HIGH' || t.priority === 'URGENT'));
  const dueSoon = open.filter((t) => t.dueDate && t.dueDate >= now && t.dueDate.getTime() - now.getTime() < 3 * DAY);

  const load = new Map<string, number>();
  for (const t of open) if (t.assigneeId) load.set(String(t.assigneeId), (load.get(String(t.assigneeId)) || 0) + 1);
  const counts = [...load.values()];
  const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const names = new Map((await Member.find({ workspaceId }).populate('userId', 'name')).filter((m) => m.userId).map((m) => [String((m.userId as any)._id), (m.userId as any).name as string]));
  const heavy = [...load.entries()].filter(([, n]) => counts.length > 1 && n >= Math.max(5, avg * 1.75)).map(([id, n]) => ({ name: names.get(id) || 'Member', open: n }));

  const ref = (ts: typeof open) => ts.slice(0, 5).map((t) => ({ id: String(t._id), title: t.title, projectId: String(t.projectId), priority: t.priority, dueDate: t.dueDate }));
  const items: { severity: 'high' | 'medium' | 'info'; title: string; detail: string; tasks?: ReturnType<typeof ref> }[] = [];
  if (overdue.length) items.push({ severity: 'high', title: `${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}`, detail: 'Past their due date and not done. Consider re-planning or re-assigning.', tasks: ref(overdue) });
  if (unassigned.length) items.push({ severity: 'high', title: `${unassigned.length} high-priority task${unassigned.length > 1 ? 's have' : ' has'} no owner`, detail: 'Important work with nobody assigned.', tasks: ref(unassigned) });
  if (blocked.length) items.push({ severity: 'high', title: `${blocked.length} blocked task${blocked.length > 1 ? 's' : ''}`, detail: 'Tagged as blocked. Resolving these may unblock dependent work.', tasks: ref(blocked) });
  if (highOpen.length) items.push({ severity: 'medium', title: `${highOpen.length} high/urgent task${highOpen.length > 1 ? 's' : ''} still open`, detail: 'Highest-priority incomplete work.', tasks: ref(highOpen) });
  if (dueSoon.length) items.push({ severity: 'medium', title: `${dueSoon.length} task${dueSoon.length > 1 ? 's' : ''} due within 3 days`, detail: 'Upcoming deadlines.', tasks: ref(dueSoon) });
  if (stale.length) items.push({ severity: 'medium', title: `${stale.length} in-progress task${stale.length > 1 ? 's' : ''} without updates for 7+ days`, detail: 'May be stuck; worth a check-in.', tasks: ref(stale) });
  if (heavy.length) items.push({ severity: 'info', title: 'Workload is uneven', detail: `${heavy.map((h) => `${h.name} (${h.open} open)`).join(', ')} carry noticeably more open tasks than the team average (${avg.toFixed(1)}). This is a capacity signal, not a performance measure.` });
  if (!items.length) items.push({ severity: 'info', title: 'Nothing needs attention', detail: open.length ? `${open.length} open tasks, none overdue or blocked.` : 'No open tasks.' });
  return { generatedAt: now, openTasks: open.length, items };
}
