import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { User, UserDoc } from '../models/User';
import { Member, Workspace, WorkspaceDoc } from '../models/Workspace';
import { verifyToken } from '../services/auth/authService';
import { unauthorized, forbidden, badRequest, notFound } from '../utils/errors';
import { can, Permission, Role } from '../config/rbac';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDoc;
      ctx?: { workspace: WorkspaceDoc; workspaceId: Types.ObjectId; role: Role };
    }
  }
}

/** 1. Authentication: valid access token whose tokenVersion matches the user's current one. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.header('authorization');
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  const p = verifyToken(h.slice(7), 'access');
  const user = await User.findById(p.sub);
  if (!user || user.tokenVersion !== p.tv) throw unauthorized('Session expired', 'TOKEN_INVALID');
  req.user = user;
  next();
}

/**
 * 2. Workspace authorization: the tenant is named by the X-Workspace-Id header and membership is verified
 * against the database on every request. Every downstream query must filter by req.ctx.workspaceId.
 */
export async function workspaceContext(req: Request, _res: Response, next: NextFunction) {
  const id = req.header('x-workspace-id') || (req.params.workspaceId as string | undefined);
  if (!id || !Types.ObjectId.isValid(id)) throw badRequest('X-Workspace-Id header is required', 'WORKSPACE_REQUIRED');
  const member = await Member.findOne({ workspaceId: id, userId: req.user!._id });
  if (!member) throw forbidden('You are not a member of this workspace', 'NOT_A_MEMBER');
  const workspace = await Workspace.findById(id);
  if (!workspace) throw notFound('Workspace');
  req.ctx = { workspace, workspaceId: workspace._id, role: member.role as Role };
  next();
}

/** 3. Role authorization. */
export const requirePerm = (perm: Permission) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.ctx || !can(req.ctx.role, perm)) throw forbidden(`Your role (${req.ctx?.role}) cannot perform this action`, 'INSUFFICIENT_ROLE');
  next();
};

export const requirePlatformAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user?.isPlatformAdmin) throw forbidden('Platform administrators only', 'ADMIN_ONLY');
  next();
};

/** Standard chain for tenant-scoped routes. */
export const tenant = [authenticate, workspaceContext];
