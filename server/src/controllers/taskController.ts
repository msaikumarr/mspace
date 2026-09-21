import { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Task, Comment, TASK_STATUSES, TASK_PRIORITIES } from '../models/Project';
import { Member } from '../models/Workspace';
import { body, ok, pid, query } from '../utils/http';
import { notFound, badRequest } from '../utils/errors';
import { audit } from '../services/auditService';
import { notify } from '../services/notifications/notificationService';
import { emitToWorkspace } from '../sockets';
import { cache } from '../config/cache';
import { createTasks } from '../services/taskService';

const taskFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  position: z.number().optional(),
};
const createSchema = z.object({ projectId: z.string(), ...taskFields });
const updateSchema = z.object(taskFields).partial();

export async function create(req: Request, res: Response) {
  const input = body(createSchema, req);
  const [task] = await createTasks(req.ctx!.workspaceId, req.user!, new Types.ObjectId(input.projectId), [input], 'manual');
  res.status(201).json(ok(task));
}

/** Persist a batch of (already human-approved) task candidates, e.g. from the AI or a meeting. */
export async function bulkCreate(req: Request, res: Response) {
  const input = body(
    z.object({ projectId: z.string(), source: z.enum(['ai', 'meeting']).default('ai'), tasks: z.array(z.object(taskFields)).min(1).max(50) }),
    req,
  );
  const tasks = await createTasks(req.ctx!.workspaceId, req.user!, new Types.ObjectId(input.projectId), input.tasks, input.source);
  await audit({ workspaceId: req.ctx!.workspaceId, actorId: req.user!._id, action: 'AI_TASKS_APPROVED', targetType: 'project', targetId: input.projectId, metadata: { count: tasks.length, source: input.source } });
  res.status(201).json(ok(tasks));
}

export async function list(req: Request, res: Response) {
  const q = query(
    z.object({
      projectId: z.string().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      assigneeId: z.string().optional(),
      q: z.string().max(100).optional(),
      overdue: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(300),
    }),
    req,
  );
  const f: Record<string, unknown> = { workspaceId: req.ctx!.workspaceId };
  if (q.projectId) f.projectId = new Types.ObjectId(q.projectId);
  if (q.status) f.status = q.status;
  if (q.priority) f.priority = q.priority;
  if (q.assigneeId) f.assigneeId = q.assigneeId === 'me' ? req.user!._id : new Types.ObjectId(q.assigneeId);
  if (q.q) f.title = { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  if (q.overdue === 'true') Object.assign(f, { dueDate: { $lt: new Date() }, status: { $ne: 'DONE' } });
  const tasks = await Task.find(f).sort({ position: 1, createdAt: 1 }).limit(q.limit);
  res.json(ok(tasks));
}

export async function get(req: Request, res: Response) {
  const t = await Task.findOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId });
  if (!t) throw notFound('Task', 'TASK_NOT_FOUND');
  res.json(ok(t));
}

export async function update(req: Request, res: Response) {
  const input = body(updateSchema, req);
  const { workspaceId } = req.ctx!;
  const task = await Task.findOne({ _id: pid(req), workspaceId });
  if (!task) throw notFound('Task', 'TASK_NOT_FOUND');
  const actor = req.user!;
  const log: string[] = [];

  if (input.assigneeId !== undefined) {
    if (input.assigneeId && !(await Member.exists({ workspaceId, userId: input.assigneeId }))) throw badRequest('Assignee must be a workspace member', 'INVALID_ASSIGNEE');
  }
  const prevAssignee = task.assigneeId ? String(task.assigneeId) : null;
  for (const k of ['title', 'description', 'priority', 'dueDate', 'labels', 'position'] as const) {
    if (input[k] !== undefined && JSON.stringify(input[k]) !== JSON.stringify((task as any)[k])) {
      (task as any)[k] = input[k];
      if (k !== 'position') log.push(`changed ${k}`);
    }
  }
  if (input.assigneeId !== undefined) {
    task.assigneeId = input.assigneeId ? new Types.ObjectId(input.assigneeId) : null;
    if ((task.assigneeId ? String(task.assigneeId) : null) !== prevAssignee) log.push('changed assignee');
  }
  let completed = false;
  if (input.status && input.status !== task.status) {
    log.push(`moved ${task.status} → ${input.status}`);
    task.status = input.status;
    completed = input.status === 'DONE';
    task.completedAt = completed ? new Date() : undefined;
  }
  for (const a of log) task.activity.push({ userId: actor._id, action: a, at: new Date() });
  await task.save();

  const link = `/app/projects/${task.projectId}?task=${task._id}`;
  const newAssignee = task.assigneeId ? String(task.assigneeId) : null;
  if (newAssignee && newAssignee !== prevAssignee) {
    await notify({ workspaceId, userIds: [newAssignee], type: 'TASK_ASSIGNED', title: `${actor.name} assigned you: ${task.title}`, link, actorId: actor._id });
  } else if (log.length && newAssignee) {
    await notify({ workspaceId, userIds: [newAssignee], type: completed ? 'TASK_COMPLETED' : 'TASK_UPDATED', title: `${task.title}: ${log[0]}`, link, actorId: actor._id });
  }
  if (completed && String(task.createdBy) !== newAssignee) {
    await notify({ workspaceId, userIds: [task.createdBy], type: 'TASK_COMPLETED', title: `Completed: ${task.title}`, link, actorId: actor._id });
  }
  emitToWorkspace(workspaceId, 'task:updated', task.toJSON());
  await cache.del(`analytics:${workspaceId}`);
  res.json(ok(task));
}

export async function remove(req: Request, res: Response) {
  const { workspaceId } = req.ctx!;
  const t = await Task.findOneAndDelete({ _id: pid(req), workspaceId });
  if (!t) throw notFound('Task', 'TASK_NOT_FOUND');
  await Comment.deleteMany({ workspaceId, taskId: t._id });
  await audit({ workspaceId, actorId: req.user!._id, action: 'TASK_DELETED', targetType: 'task', targetId: String(t._id), metadata: { title: t.title } });
  emitToWorkspace(workspaceId, 'task:deleted', { id: String(t._id), projectId: String(t.projectId) });
  await cache.del(`analytics:${workspaceId}`);
  res.json(ok({ deleted: true }));
}

export async function listComments(req: Request, res: Response) {
  const { workspaceId } = req.ctx!;
  if (!(await Task.exists({ _id: pid(req), workspaceId }))) throw notFound('Task', 'TASK_NOT_FOUND');
  const cs = await Comment.find({ workspaceId, taskId: pid(req) }).sort({ createdAt: 1 }).populate('userId', 'name avatarColor');
  res.json(ok(cs.map((c) => ({ ...c.toJSON(), user: c.userId, userId: (c.userId as any)?._id ?? c.userId }))));
}

export async function addComment(req: Request, res: Response) {
  const { text, mentions } = body(z.object({ text: z.string().trim().min(1).max(5000), mentions: z.array(z.string()).max(20).optional() }), req);
  const { workspaceId } = req.ctx!;
  const task = await Task.findOne({ _id: pid(req), workspaceId });
  if (!task) throw notFound('Task', 'TASK_NOT_FOUND');
  const valid = mentions?.length ? (await Member.find({ workspaceId, userId: { $in: mentions } })).map((m) => m.userId) : [];
  const c = await Comment.create({ workspaceId, taskId: task._id, userId: req.user!._id, text, mentions: valid });
  const link = `/app/projects/${task.projectId}?task=${task._id}`;
  await notify({ workspaceId, userIds: valid, type: 'MENTION', title: `${req.user!.name} mentioned you on ${task.title}`, body: text.slice(0, 140), link, actorId: req.user!._id });
  await notify({ workspaceId, userIds: [task.assigneeId, task.createdBy].filter(Boolean).filter((u) => !valid.some((v) => String(v) === String(u))), type: 'COMMENT', title: `${req.user!.name} commented on ${task.title}`, body: text.slice(0, 140), link, actorId: req.user!._id });
  const payload = { ...c.toJSON(), user: { id: String(req.user!._id), name: req.user!.name, avatarColor: req.user!.avatarColor } };
  emitToWorkspace(workspaceId, 'comment:new', payload);
  res.status(201).json(ok(payload));
}
