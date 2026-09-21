import { Task } from '../models/Project';
import { notify } from '../services/notifications/notificationService';
import { logger } from '../utils/logger';

/** Notifies assignees once when a task is due within 24h (or already overdue). */
export async function scanDeadlines() {
  const soon = new Date(Date.now() + 24 * 3600 * 1000);
  const tasks = await Task.find({ status: { $ne: 'DONE' }, assigneeId: { $ne: null }, dueDate: { $lte: soon }, deadlineNotified: false }).limit(500);
  for (const t of tasks) {
    const overdue = t.dueDate! < new Date();
    await notify({
      workspaceId: t.workspaceId,
      userIds: [t.assigneeId],
      type: 'DEADLINE',
      title: overdue ? `Overdue: ${t.title}` : `Due within 24h: ${t.title}`,
      link: `/app/projects/${t.projectId}?task=${t._id}`,
    });
    t.deadlineNotified = true;
    await t.save();
  }
  return tasks.length;
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  const run = () => scanDeadlines().catch((e) => logger.error('deadline scan failed', { err: String(e) }));
  setTimeout(run, 10_000).unref();
  timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}
export const stopScheduler = () => timer && clearInterval(timer);
