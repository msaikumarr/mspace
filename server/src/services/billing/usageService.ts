import { Types } from 'mongoose';
import { Usage } from '../../models/Misc';
import { Member, Workspace, WorkspaceDoc } from '../../models/Workspace';
import { Project } from '../../models/Project';
import { DocumentModel } from '../../models/Knowledge';
import { getPlan, Plan } from '../../config/plans';
import { limitExceeded, forbidden } from '../../utils/errors';
import type { Id } from '../../utils/http';

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

export async function aiCreditsUsed(workspaceId: Id) {
  const r = await Usage.aggregate([
    { $match: { workspaceId: new Types.ObjectId(String(workspaceId)), createdAt: { $gte: monthStart() } } },
    { $group: { _id: null, credits: { $sum: '$credits' } } },
  ]);
  return (r[0]?.credits as number) || 0;
}

export async function assertAiQuota(ws: WorkspaceDoc, credits = 1) {
  const plan = getPlan(ws.plan);
  const used = await aiCreditsUsed(ws._id);
  if (used + credits > plan.aiRequestsPerMonth) {
    throw limitExceeded(`AI usage limit reached for the ${plan.name} plan (${plan.aiRequestsPerMonth}/month). Upgrade to continue.`, 'AI_LIMIT_EXCEEDED');
  }
}

export const recordUsage = (workspaceId: Id, userId: Id, requestType: string, credits = 1) =>
  Usage.create({ workspaceId, userId, requestType, credits });

export function assertFeature(ws: WorkspaceDoc, feature: keyof Plan['features']) {
  const plan = getPlan(ws.plan);
  if (!plan.features[feature]) throw forbidden(`"${feature}" is not included in the ${plan.name} plan. Upgrade to unlock it.`, 'UPGRADE_REQUIRED');
}

export async function assertMemberCapacity(ws: WorkspaceDoc) {
  const plan = getPlan(ws.plan);
  const n = await Member.countDocuments({ workspaceId: ws._id });
  if (n >= plan.maxMembers) throw limitExceeded(`The ${plan.name} plan allows up to ${plan.maxMembers} members. Upgrade to add more.`, 'MEMBER_LIMIT_EXCEEDED');
}

export async function assertProjectCapacity(ws: WorkspaceDoc) {
  const plan = getPlan(ws.plan);
  const n = await Project.countDocuments({ workspaceId: ws._id });
  if (n >= plan.maxProjects) throw limitExceeded(`The ${plan.name} plan allows up to ${plan.maxProjects} projects. Upgrade to add more.`, 'PROJECT_LIMIT_EXCEEDED');
}

export async function assertStorage(ws: WorkspaceDoc, incomingBytes: number) {
  const plan = getPlan(ws.plan);
  const r = await DocumentModel.aggregate([{ $match: { workspaceId: ws._id } }, { $group: { _id: null, bytes: { $sum: '$size' } } }]);
  const used = (r[0]?.bytes as number) || 0;
  if (used + incomingBytes > plan.storageMb * 1024 * 1024) throw limitExceeded(`Storage limit of ${plan.storageMb} MB reached. Upgrade for more.`, 'STORAGE_LIMIT_EXCEEDED');
}

export async function usageSummary(ws: WorkspaceDoc) {
  const plan = getPlan(ws.plan);
  const [members, projects, ai, storage] = await Promise.all([
    Member.countDocuments({ workspaceId: ws._id }),
    Project.countDocuments({ workspaceId: ws._id }),
    aiCreditsUsed(ws._id),
    DocumentModel.aggregate([{ $match: { workspaceId: ws._id } }, { $group: { _id: null, bytes: { $sum: '$size' } } }]),
  ]);
  return {
    plan,
    usage: {
      members: { used: members, limit: plan.maxMembers },
      projects: { used: projects, limit: plan.maxProjects },
      aiRequests: { used: ai, limit: plan.aiRequestsPerMonth },
      storageMb: { used: Math.round(((storage[0]?.bytes || 0) / 1024 / 1024) * 10) / 10, limit: plan.storageMb },
    },
  };
}

/** Refuses a move to a plan whose limits the workspace already exceeds. */
export async function assertPlanFits(ws: WorkspaceDoc, planId: Plan['id']) {
  const next = getPlan(planId);
  const s = await usageSummary(ws);
  if (s.usage.members.used > next.maxMembers) throw limitExceeded(`You have ${s.usage.members.used} members; ${next.name} allows ${next.maxMembers}. Remove members first.`, 'DOWNGRADE_BLOCKED');
  if (s.usage.projects.used > next.maxProjects) throw limitExceeded(`You have ${s.usage.projects.used} projects; ${next.name} allows ${next.maxProjects}. Remove projects first.`, 'DOWNGRADE_BLOCKED');
}

/** Simulated billing only: switches the plan directly, with no payment. */
export async function changePlan(ws: WorkspaceDoc, planId: Plan['id']) {
  await assertPlanFits(ws, planId);
  await Workspace.updateOne(
    { _id: ws._id },
    { plan: planId, 'subscription.status': 'active', 'subscription.currentPeriodEnd': new Date(Date.now() + 30 * 24 * 3600 * 1000) },
  );
}
