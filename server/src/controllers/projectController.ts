import { Request, Response } from 'express';
import { z } from 'zod';
import { Project, Task, Comment } from '../models/Project';
import { DocumentModel, DocChunk } from '../models/Knowledge';
import { Member } from '../models/Workspace';
import { body, ok, pid } from '../utils/http';
import { notFound, badRequest } from '../utils/errors';
import { audit } from '../services/auditService';
import { assertProjectCapacity } from '../services/billing/usageService';
import { emitToWorkspace } from '../sockets';
import { cache } from '../config/cache';
import { storage } from '../services/storage';
import { Types } from 'mongoose';

const date = z.coerce.date().nullable().optional();
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000).optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED']).optional(),
  memberIds: z.array(z.string()).optional(),
  startDate: date,
  deadline: date,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

async function validMembers(workspaceId: Types.ObjectId, ids?: string[]) {
  if (!ids?.length) return [];
  const found = await Member.find({ workspaceId, userId: { $in: ids } }).select('userId');
  if (found.length !== new Set(ids).size) throw badRequest('All project members must belong to the workspace', 'INVALID_MEMBER');
  return found.map((m) => m.userId);
}

export async function create(req: Request, res: Response) {
  const input = body(createSchema, req);
  const { workspace, workspaceId } = req.ctx!;
  await assertProjectCapacity(workspace);
  const memberIds = await validMembers(workspaceId, input.memberIds);
  if (!memberIds.some((m) => String(m) === String(req.user!._id))) memberIds.push(req.user!._id);
  const project = await Project.create({ ...input, memberIds, workspaceId, createdBy: req.user!._id });
  await audit({ workspaceId, actorId: req.user!._id, action: 'PROJECT_CREATED', targetType: 'project', targetId: String(project._id), metadata: { name: project.name } });
  emitToWorkspace(workspaceId, 'project:created', project.toJSON());
  await cache.del(`analytics:${workspaceId}`);
  res.status(201).json(ok(project));
}

export async function list(req: Request, res: Response) {
  const workspaceId = req.ctx!.workspaceId;
  const [projects, counts] = await Promise.all([
    Project.find({ workspaceId }).sort({ createdAt: -1 }),
    Task.aggregate([{ $match: { workspaceId } }, { $group: { _id: { p: '$projectId', done: { $eq: ['$status', 'DONE'] } }, n: { $sum: 1 } } }]),
  ]);
  const stat = new Map<string, { total: number; done: number }>();
  for (const c of counts) {
    const k = String(c._id.p);
    const s = stat.get(k) || { total: 0, done: 0 };
    s.total += c.n;
    if (c._id.done) s.done += c.n;
    stat.set(k, s);
  }
  res.json(ok(projects.map((p) => ({ ...p.toJSON(), taskCount: stat.get(String(p._id))?.total || 0, doneCount: stat.get(String(p._id))?.done || 0 }))));
}

export async function get(req: Request, res: Response) {
  const p = await Project.findOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId });
  if (!p) throw notFound('Project', 'PROJECT_NOT_FOUND');
  res.json(ok(p));
}

export async function update(req: Request, res: Response) {
  const input = body(createSchema.partial(), req);
  const { workspaceId } = req.ctx!;
  const patch: Record<string, unknown> = { ...input };
  if (input.memberIds) patch.memberIds = await validMembers(workspaceId, input.memberIds);
  const p = await Project.findOneAndUpdate({ _id: pid(req), workspaceId }, patch, { new: true });
  if (!p) throw notFound('Project', 'PROJECT_NOT_FOUND');
  emitToWorkspace(workspaceId, 'project:updated', p.toJSON());
  await cache.del(`analytics:${workspaceId}`);
  res.json(ok(p));
}

export async function remove(req: Request, res: Response) {
  const { workspaceId } = req.ctx!;
  const id = pid(req);
  const p = await Project.findOneAndDelete({ _id: id, workspaceId });
  if (!p) throw notFound('Project', 'PROJECT_NOT_FOUND');
  const tasks = await Task.find({ workspaceId, projectId: id }).select('_id');
  await Comment.deleteMany({ workspaceId, taskId: { $in: tasks.map((t) => t._id) } });
  await Task.deleteMany({ workspaceId, projectId: id });
  const docs = await DocumentModel.find({ workspaceId, projectId: id });
  await Promise.all(docs.map((d) => storage.remove(d.storagePath)));
  await DocChunk.deleteMany({ workspaceId, documentId: { $in: docs.map((d) => d._id) } });
  await DocumentModel.deleteMany({ workspaceId, projectId: id });
  await audit({ workspaceId, actorId: req.user!._id, action: 'PROJECT_DELETED', targetType: 'project', targetId: String(id), metadata: { name: p.name } });
  emitToWorkspace(workspaceId, 'project:deleted', { id: String(id) });
  await cache.del(`analytics:${workspaceId}`);
  res.json(ok({ deleted: true }));
}
