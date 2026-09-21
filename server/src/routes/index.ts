import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, workspaceContext, requirePerm, requirePlatformAdmin, tenant } from '../middleware/auth';
import { requireFeature, aiUsage } from '../middleware/guards';
import * as authC from '../controllers/authController';
import * as wsC from '../controllers/workspaceController';
import * as projC from '../controllers/projectController';
import * as taskC from '../controllers/taskController';
import * as chatC from '../controllers/chatController';
import * as docC from '../controllers/documentController';
import * as aiC from '../controllers/aiController';
import * as meetC from '../controllers/meetingController';
import * as miscC from '../controllers/miscController';
import * as billingC from '../controllers/billingController';
import * as oauthC from '../controllers/oauthController';

const enabled = process.env.NODE_ENV !== 'test' || process.env.RATE_LIMIT === 'on';
const limiter = (windowMs: number, max: number, code: string) =>
  rateLimit({
    windowMs, limit: max, standardHeaders: true, legacyHeaders: false, skip: () => !enabled,
    handler: (_req, res) => res.status(429).json({ success: false, error: { code, message: 'Too many requests, please slow down and try again shortly.' } }),
  });

export const authLimiter = limiter(15 * 60 * 1000, 30, 'AUTH_RATE_LIMITED');
export const apiLimiter = limiter(60 * 1000, 600, 'RATE_LIMITED');

/** For /workspaces/:id routes: treat the URL id as the tenant and run the normal membership check. */
const paramTenant = (req: Request, _res: Response, next: NextFunction) => {
  req.headers['x-workspace-id'] = req.params.id as string;
  next();
};
const wsRoute = [authenticate, paramTenant, workspaceContext];

const r = Router();
r.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));

// ---- Auth
r.post('/auth/register', authLimiter, authC.register);
r.post('/auth/login', authLimiter, authC.login);
r.post('/auth/refresh', authC.refresh);
r.post('/auth/logout', authC.logout);
r.post('/auth/logout-all', authenticate, authC.logoutAll);
r.post('/auth/verify-email', authLimiter, authC.verifyEmail);
r.post('/auth/resend-verification', authenticate, authLimiter, authC.resendVerification);
r.post('/auth/forgot-password', authLimiter, authC.forgotPassword);
r.post('/auth/reset-password', authLimiter, authC.resetPassword);
r.get('/auth/me', authenticate, authC.me);
r.patch('/auth/me', authenticate, authC.updateProfile);
r.post('/auth/change-password', authenticate, authLimiter, authC.changePassword);
r.get('/auth/oauth/providers', oauthC.providers);
r.get('/auth/oauth/connections', authenticate, oauthC.list);
r.get('/auth/oauth/:provider/start', authLimiter, oauthC.start);
r.get('/auth/oauth/:provider/callback', authLimiter, oauthC.callback);
r.post('/auth/oauth/:provider/link', authenticate, authLimiter, oauthC.link);
r.delete('/auth/oauth/:provider', authenticate, oauthC.unlink);

// ---- Workspaces & members
r.post('/workspaces', authenticate, wsC.create);
r.get('/workspaces', authenticate, wsC.list);
r.get('/workspaces/:id', wsRoute, wsC.get);
r.patch('/workspaces/:id', wsRoute, requirePerm('workspace:manage'), wsC.update);
r.delete('/workspaces/:id', wsRoute, requirePerm('workspace:delete'), wsC.remove);
r.get('/workspaces/:id/members', wsRoute, wsC.members);
r.get('/workspaces/:id/invites', wsRoute, requirePerm('member:invite'), wsC.listInvites);
r.post('/workspaces/:id/invites', wsRoute, requirePerm('member:invite'), wsC.invite);
r.delete('/workspaces/:id/invites/:inviteId', wsRoute, requirePerm('member:invite'), wsC.revokeInvite);
r.patch('/workspaces/:id/members/:userId', wsRoute, requirePerm('member:manage'), wsC.changeRole);
r.delete('/workspaces/:id/members/:userId', wsRoute, wsC.removeMember); // permission logic inside: admins, or self-leave

// ---- Tenant-scoped resources (X-Workspace-Id header)
r.get('/projects', tenant, requirePerm('project:view'), projC.list);
r.post('/projects', tenant, requirePerm('project:create'), projC.create);
r.get('/projects/:id', tenant, requirePerm('project:view'), projC.get);
r.patch('/projects/:id', tenant, requirePerm('project:edit'), projC.update);
r.delete('/projects/:id', tenant, requirePerm('project:delete'), projC.remove);

r.get('/tasks', tenant, requirePerm('task:view'), taskC.list);
r.post('/tasks', tenant, requirePerm('task:create'), taskC.create);
r.post('/tasks/bulk', tenant, requirePerm('task:create'), taskC.bulkCreate);
r.get('/tasks/:id', tenant, requirePerm('task:view'), taskC.get);
r.patch('/tasks/:id', tenant, requirePerm('task:edit'), taskC.update);
r.delete('/tasks/:id', tenant, requirePerm('task:delete'), taskC.remove);
r.get('/tasks/:id/comments', tenant, requirePerm('task:view'), taskC.listComments);
r.post('/tasks/:id/comments', tenant, requirePerm('task:edit'), taskC.addComment);

r.get('/channels', tenant, requirePerm('chat:read'), chatC.listChannels);
r.post('/channels', tenant, requirePerm('chat:write'), chatC.createChannel);
r.post('/channels/dm', tenant, requirePerm('chat:write'), chatC.openDm);
r.get('/channels/:id/messages', tenant, requirePerm('chat:read'), chatC.listMessages);
r.post('/channels/:id/messages', tenant, requirePerm('chat:write'), chatC.chatUpload, chatC.sendMessage);
r.post('/channels/:id/read', tenant, requirePerm('chat:read'), chatC.markRead);
r.patch('/messages/:id', tenant, requirePerm('chat:write'), chatC.editMessage);
r.delete('/messages/:id', tenant, requirePerm('chat:write'), chatC.deleteMessage);
r.post('/messages/:id/reactions', tenant, requirePerm('chat:write'), chatC.react);
r.get('/messages/:id/file', tenant, requirePerm('chat:read'), chatC.downloadFile);

r.get('/notifications', tenant, chatC.listNotifications);
r.post('/notifications/read-all', tenant, chatC.readAllNotifications);
r.post('/notifications/:id/read', tenant, chatC.readNotification);

r.get('/documents', tenant, requirePerm('document:view'), docC.list);
r.post('/documents', tenant, requirePerm('document:upload'), docC.docUpload, docC.upload);
r.get('/documents/:id', tenant, requirePerm('document:view'), docC.get);
r.get('/documents/:id/download', tenant, requirePerm('document:view'), docC.download);
r.delete('/documents/:id', tenant, requirePerm('document:delete'), docC.remove);

// ---- AI (RBAC -> plan feature -> monthly quota)
const ai = [...tenant, requirePerm('ai:use')];
r.post('/ai/chat', ...ai, aiUsage('chat'), aiC.chat);
r.get('/ai/conversations', ...ai, aiC.listConversations);
r.get('/ai/conversations/:id', ...ai, aiC.getConversation);
r.delete('/ai/conversations/:id', ...ai, aiC.deleteConversation);
r.post('/ai/summarize', ...ai, aiUsage('summarize'), aiC.summarize);
r.post('/ai/generate-tasks', ...ai, aiUsage('generate-tasks'), aiC.generateTasks);
r.post('/ai/document-query', ...ai, requireFeature('rag'), aiUsage('document-query'), aiC.documentQuery);
r.post('/ai/insights', ...ai, aiUsage('insights'), aiC.insights);

const meet = [...tenant, requireFeature('meetings')];
r.get('/meetings/capabilities', ...tenant, meetC.capabilities); // before /meetings/:id
r.get('/meetings', ...meet, requirePerm('meeting:manage'), meetC.list);
r.post('/meetings/audio', ...meet, requirePerm('meeting:manage'), meetC.audioUpload, meetC.createFromAudio);
r.post('/meetings', ...meet, requirePerm('meeting:manage'), aiUsage('meeting'), meetC.create);
r.get('/meetings/:id', ...meet, requirePerm('meeting:manage'), meetC.get);
r.post('/meetings/:id/approve', ...meet, requirePerm('meeting:manage'), meetC.approve);
r.delete('/meetings/:id', ...meet, requirePerm('meeting:manage'), meetC.remove);

r.get('/analytics', tenant, requirePerm('analytics:view'), miscC.analytics);
r.get('/presence', tenant, miscC.presence);
r.get('/billing', tenant, billingC.overview);
r.post('/billing/change-plan', tenant, requirePerm('billing:manage'), billingC.changeBillingPlan);
r.post('/billing/checkout', tenant, requirePerm('billing:manage'), billingC.checkout);
r.post('/billing/portal', tenant, requirePerm('billing:manage'), billingC.portal);
r.get('/audit-logs', tenant, requirePerm('audit:view'), requireFeature('auditLogs'), miscC.auditLogs);
r.get('/admin/stats', authenticate, requirePlatformAdmin, miscC.adminStats);

export default r;
