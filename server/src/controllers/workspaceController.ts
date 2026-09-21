import { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { Workspace, Member, Invite } from '../models/Workspace';
import { User } from '../models/User';
import { Project, Task, Comment } from '../models/Project';
import { Channel, Message } from '../models/Chat';
import { Notification, AuditLog, Usage } from '../models/Misc';
import { DocumentModel, DocChunk, Meeting, AiConversation } from '../models/Knowledge';
import { ROLES, Role, outranks } from '../config/rbac';
import { body, ok, pid } from '../utils/http';
import { createWorkspace } from '../services/workspaceService';
import { audit } from '../services/auditService';
import { notify } from '../services/notifications/notificationService';
import { assertMemberCapacity } from '../services/billing/usageService';
import { sendInviteEmail } from '../services/auth/authService';
import { verificationRequired } from '../config/mail';
import { conflict, forbidden, notFound, badRequest } from '../utils/errors';
import { emitToWorkspace, disconnectUser } from '../sockets';
import { storage } from '../services/storage';

export async function create(req: Request, res: Response) {
  const { name } = body(z.object({ name: z.string().trim().min(1).max(80) }), req);
  const ws = await createWorkspace(req.user!, name);
  res.status(201).json(ok({ ...ws.toJSON(), role: 'owner' }));
}

export async function list(req: Request, res: Response) {
  const ms = await Member.find({ userId: req.user!._id }).populate('workspaceId');
  res.json(ok(ms.map((m) => ({ ...(m.workspaceId as any).toJSON(), role: m.role }))));
}

export async function get(req: Request, res: Response) {
  res.json(ok({ ...req.ctx!.workspace.toJSON(), role: req.ctx!.role }));
}

export async function update(req: Request, res: Response) {
  const { name } = body(z.object({ name: z.string().trim().min(1).max(80) }), req);
  const ws = await Workspace.findByIdAndUpdate(req.ctx!.workspaceId, { name }, { new: true });
  res.json(ok({ ...ws!.toJSON(), role: req.ctx!.role }));
}

/** Deleting a tenant removes every tenant-scoped record and its uploaded files. */
export async function remove(req: Request, res: Response) {
  const { confirmName } = body(z.object({ confirmName: z.string() }), req);
  if (confirmName !== req.ctx!.workspace.name) throw badRequest('Type the workspace name to confirm deletion', 'CONFIRMATION_MISMATCH');
  const w = req.ctx!.workspaceId;
  // Everything new lives under the workspace's key prefix (removed below); only records that predate storage
  // keys point outside it, as absolute local paths.
  const docs = await DocumentModel.find({ workspaceId: w });
  await Promise.all(docs.filter((d) => path.isAbsolute(d.storagePath)).map((d) => storage.remove(d.storagePath)));
  await Promise.all(
    [Member, Invite, Project, Task, Comment, Channel, Message, Notification, AuditLog, Usage, DocumentModel, DocChunk, Meeting, AiConversation].map((M: any) =>
      M.deleteMany({ workspaceId: w }),
    ),
  );
  await Workspace.deleteOne({ _id: w });
  await storage.removePrefix(String(w));
  res.json(ok({ deleted: true }));
}

export async function members(req: Request, res: Response) {
  const ms = await Member.find({ workspaceId: req.ctx!.workspaceId }).populate('userId', 'name email avatarColor title lastActiveAt');
  res.json(ok(ms.filter((m) => m.userId).map((m) => ({ id: String(m._id), role: m.role, joinedAt: (m as any).createdAt, user: (m.userId as any).toJSON() }))));
}

export async function listInvites(req: Request, res: Response) {
  res.json(ok(await Invite.find({ workspaceId: req.ctx!.workspaceId }).sort({ createdAt: -1 })));
}

export async function invite(req: Request, res: Response) {
  const { email: raw, role } = body(z.object({ email: z.string().email(), role: z.enum(ROLES).default('member') }), req);
  const email = raw.toLowerCase();
  const { workspace, workspaceId, role: actorRole } = req.ctx!;
  if (role === 'owner') throw badRequest('Ownership cannot be granted by invitation', 'INVALID_ROLE');
  if (!outranks(actorRole, role) && actorRole !== 'owner') throw forbidden('You can only grant roles below your own', 'INSUFFICIENT_ROLE');

  const existing = await User.findOne({ email });
  if (existing && (await Member.exists({ workspaceId, userId: existing._id }))) throw conflict('That person is already a member', 'ALREADY_MEMBER');
  await assertMemberCapacity(workspace);

  // An existing account is added at once only if its address is verified (or this server cannot verify addresses at all).
  // Otherwise whoever registered it might not be the person the inviter meant, so the invitation waits for verification.
  const addNow = !!existing && (existing.emailVerified || !verificationRequired());
  if (addNow && existing) {
    await Member.create({ workspaceId, userId: existing._id, role });
    await notify({ workspaceId, userIds: [existing._id], type: 'INVITATION', title: `You were added to ${workspace.name}`, body: `Role: ${role}`, link: '/app', actorId: req.user!._id });
    emitToWorkspace(workspaceId, 'member:joined', { userId: String(existing._id) });
  } else {
    await Invite.findOneAndUpdate({ workspaceId, email }, { role, invitedBy: req.user!._id }, { upsert: true });
    await sendInviteEmail(email, req.user!.name, workspace.name, role);
  }
  await audit({ workspaceId, actorId: req.user!._id, action: 'USER_INVITED', targetType: 'user', targetId: email, metadata: { role, pending: !addNow } });
  res.status(201).json(ok({ email, role, status: addNow ? 'added' : 'pending' }));
}

export async function revokeInvite(req: Request, res: Response) {
  const r = await Invite.deleteOne({ _id: pid(req, 'inviteId'), workspaceId: req.ctx!.workspaceId });
  if (!r.deletedCount) throw notFound('Invite');
  res.json(ok({ revoked: true }));
}

export async function changeRole(req: Request, res: Response) {
  const { role } = body(z.object({ role: z.enum(ROLES) }), req);
  const { workspaceId, role: actorRole } = req.ctx!;
  const target = await Member.findOne({ workspaceId, userId: pid(req, 'userId') });
  if (!target) throw notFound('Member');
  if (target.role === 'owner' || role === 'owner') throw forbidden('The owner role cannot be changed', 'OWNER_IMMUTABLE');
  if (!outranks(actorRole, target.role as Role) || !outranks(actorRole, role)) throw forbidden('You can only manage roles below your own', 'INSUFFICIENT_ROLE');
  const before = target.role;
  target.role = role;
  await target.save();
  await audit({ workspaceId, actorId: req.user!._id, action: 'ROLE_CHANGED', targetType: 'user', targetId: String(target.userId), metadata: { from: before, to: role } });
  await notify({ workspaceId, userIds: [target.userId], type: 'PROJECT_UPDATE', title: `Your role is now ${role}`, actorId: req.user!._id });
  res.json(ok({ userId: String(target.userId), role }));
}

export async function removeMember(req: Request, res: Response) {
  const { workspaceId, role: actorRole } = req.ctx!;
  const userId = pid(req, 'userId');
  const target = await Member.findOne({ workspaceId, userId });
  if (!target) throw notFound('Member');
  if (target.role === 'owner') throw forbidden('The owner cannot be removed', 'OWNER_IMMUTABLE');
  const self = String(userId) === String(req.user!._id);
  if (!self && (actorRole !== 'owner' && actorRole !== 'admin' || !outranks(actorRole, target.role as Role))) throw forbidden('You cannot remove this member', 'INSUFFICIENT_ROLE');
  await Member.deleteOne({ _id: target._id });
  disconnectUser(userId);
  await Task.updateMany({ workspaceId, assigneeId: userId }, { assigneeId: null });
  await Project.updateMany({ workspaceId }, { $pull: { memberIds: userId } });
  await audit({ workspaceId, actorId: req.user!._id, action: 'MEMBER_REMOVED', targetType: 'user', targetId: String(userId) });
  res.json(ok({ removed: true }));
}
