import { AuditLog } from '../models/Misc';
import { logger } from '../utils/logger';
import type { Id } from '../utils/http';

export const AUDIT_ACTIONS = [
  'WORKSPACE_CREATED', 'USER_INVITED', 'INVITE_ACCEPTED', 'ROLE_CHANGED', 'MEMBER_REMOVED', 'PROJECT_CREATED', 'PROJECT_DELETED',
  'TASK_CREATED', 'TASK_DELETED', 'DOCUMENT_UPLOADED', 'DOCUMENT_DELETED', 'SUBSCRIPTION_CHANGED', 'AI_TASKS_APPROVED',
] as const;

interface AuditInput {
  workspaceId: Id;
  actorId?: Id;
  action: (typeof AUDIT_ACTIONS)[number];
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Audit writes must never break the request that triggered them. */
export async function audit(a: AuditInput) {
  try {
    await AuditLog.create(a);
  } catch (e) {
    logger.error('audit write failed', { err: String(e) });
  }
}
