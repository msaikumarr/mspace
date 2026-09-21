import { Types, HydratedDocument, InferSchemaType } from 'mongoose';
import { Task, Project, TaskStatus, TaskPriority } from '../models/Project';
import { Member } from '../models/Workspace';
import { UserDoc } from '../models/User';
import { badRequest, notFound } from '../utils/errors';
import { audit } from './auditService';
import { notify } from './notifications/notificationService';
import { emitToWorkspace } from '../sockets';
import { cache } from '../config/cache';

interface TaskInput {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeId?: string | null;
  dueDate?: Date | null;
  labels?: string[];
  position?: number;
}

/**
 * Single write path for creating tasks (manual, AI-approved and meeting-approved) so tenant checks,
 * audit records, notifications and realtime events stay consistent.
 */
export async function createTasks(workspaceId: Types.ObjectId, actor: UserDoc, projectId: Types.ObjectId, inputs: TaskInput[], source: 'manual' | 'ai' | 'meeting') {
  const project = await Project.findOne({ _id: projectId, workspaceId });
  if (!project) throw notFound('Project', 'PROJECT_NOT_FOUND');

  const assigneeIds = [...new Set(inputs.map((i) => i.assigneeId).filter(Boolean))] as string[];
  if (assigneeIds.length) {
    const found = await Member.countDocuments({ workspaceId, userId: { $in: assigneeIds } });
    if (found !== assigneeIds.length) throw badRequest('Assignee must be a workspace member', 'INVALID_ASSIGNEE');
  }

  const last = await Task.findOne({ workspaceId, projectId }).sort({ position: -1 }).select('position');
  let pos = (last?.position ?? 0) + 1000;
  const created: HydratedDocument<InferSchemaType<typeof Task.schema>>[] = [];
  for (const i of inputs) {
    const t = await Task.create({
      workspaceId,
      projectId,
      title: i.title,
      description: i.description || '',
      status: (i.status || 'TODO') as TaskStatus,
      priority: (i.priority || 'MEDIUM') as TaskPriority,
      assigneeId: i.assigneeId || null,
      dueDate: i.dueDate || undefined,
      labels: i.labels || [],
      position: i.position ?? (pos += 1000),
      createdBy: actor._id,
      source,
      completedAt: i.status === 'DONE' ? new Date() : undefined,
      activity: [{ userId: actor._id, action: source === 'manual' ? 'created the task' : `created from ${source} suggestion`, at: new Date() }],
    });
    await audit({ workspaceId, actorId: actor._id, action: 'TASK_CREATED', targetType: 'task', targetId: String(t._id), metadata: { title: t.title, source } });
    if (t.assigneeId) {
      await notify({ workspaceId, userIds: [t.assigneeId], type: 'TASK_ASSIGNED', title: `${actor.name} assigned you: ${t.title}`, link: `/app/projects/${projectId}?task=${t._id}`, actorId: actor._id });
    }
    emitToWorkspace(workspaceId, 'task:created', t.toJSON());
    created.push(t);
  }
  await cache.del(`analytics:${workspaceId}`);
  return created;
}
