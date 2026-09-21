import { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { computeAnalytics } from '../services/analyticsService';
import { getPlan } from '../config/plans';
import { audit } from '../services/auditService';
import { AuditLog, Usage } from '../models/Misc';
import { Workspace } from '../models/Workspace';
import { User } from '../models/User';
import { Project, Task } from '../models/Project';
import { DocumentModel } from '../models/Knowledge';
import { body, ok, query } from '../utils/http';
import { badRequest } from '../utils/errors';
import { onlineUsers } from '../sockets';

export async function analytics(req: Request, res: Response) {
  const { projectId } = query(z.object({ projectId: z.string().regex(/^[a-f\d]{24}$/i).optional() }), req);
  const data = await computeAnalytics(req.ctx!.workspaceId, projectId ? new Types.ObjectId(projectId) : undefined);
  if (!getPlan(req.ctx!.workspace.plan).features.advancedAnalytics) {
    return res.json(ok({ ...data, locked: true, weekly: [], activity: [], workload: [], projects: [] }));
  }
  res.json(ok({ ...data, locked: false }));
}

export async function auditLogs(req: Request, res: Response) {
  const q = query(z.object({ action: z.string().optional(), before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req);
  const f: Record<string, unknown> = { workspaceId: req.ctx!.workspaceId };
  if (q.action) f.action = q.action;
  if (q.before) f.createdAt = { $lt: new Date(q.before) };
  const logs = await AuditLog.find(f).sort({ createdAt: -1 }).limit(q.limit).populate('actorId', 'name email');
  res.json(ok(logs.map((l) => ({ ...l.toJSON(), actor: l.actorId, actorId: (l.actorId as any)?._id ?? l.actorId }))));
}

export async function adminStats(_req: Request, res: Response) {
  const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [orgs, users, active, projects, tasks, aiTotal, ai30, storage, plans, recent] = await Promise.all([
    Workspace.countDocuments(),
    User.countDocuments(),
    User.countDocuments({ lastActiveAt: { $gte: since30 } }),
    Project.countDocuments(),
    Task.countDocuments(),
    Usage.countDocuments(),
    Usage.countDocuments({ createdAt: { $gte: since30 } }),
    DocumentModel.aggregate([{ $group: { _id: null, bytes: { $sum: '$size' } } }]),
    Workspace.aggregate([{ $group: { _id: '$plan', n: { $sum: 1 } } }]),
    AuditLog.find().sort({ createdAt: -1 }).limit(20).populate('workspaceId', 'name').populate('actorId', 'name'),
  ]);
  res.json(
    ok({
      organizations: orgs,
      users,
      activeUsers30d: active,
      projects,
      tasks,
      aiRequests: { total: aiTotal, last30d: ai30 },
      storageBytes: storage[0]?.bytes || 0,
      subscriptions: ['free', 'pro', 'business'].map((p) => ({ plan: p, count: plans.find((x) => x._id === p)?.n || 0 })),
      recentActivity: recent.map((l) => ({ id: String(l._id), action: l.action, at: (l as any).createdAt, workspace: (l.workspaceId as any)?.name, actor: (l.actorId as any)?.name })),
    }),
  );
}

export async function presence(req: Request, res: Response) {
  res.json(ok(onlineUsers(String(req.ctx!.workspaceId))));
}
