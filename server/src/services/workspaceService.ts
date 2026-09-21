import crypto from 'crypto';
import { Types } from 'mongoose';
import { Workspace, Member } from '../models/Workspace';
import { Channel } from '../models/Chat';
import { UserDoc } from '../models/User';
import { audit } from './auditService';

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace';

export async function createWorkspace(user: UserDoc, name: string) {
  const slug = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
  const workspace = await Workspace.create({ name, slug, ownerId: user._id });
  await Member.create({ workspaceId: workspace._id, userId: user._id, role: 'owner' });
  await Channel.insertMany([
    { workspaceId: workspace._id, name: 'general', createdBy: user._id },
    { workspaceId: workspace._id, name: 'announcements', createdBy: user._id },
  ]);
  await audit({ workspaceId: workspace._id, actorId: user._id, action: 'WORKSPACE_CREATED', targetType: 'workspace', targetId: String(workspace._id) });
  return workspace;
}

export const dmKey = (a: unknown, b: unknown) => [String(a), String(b)].sort().join(':');
export const asId = (v: unknown) => new Types.ObjectId(String(v));
