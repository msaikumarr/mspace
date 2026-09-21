import { Notification, NotificationType } from '../../models/Misc';
import { emitToUser } from '../../sockets';
import { logger } from '../../utils/logger';

interface NotifyInput {
  workspaceId: unknown;
  userIds: unknown[];
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  actorId?: unknown; // never notify people about their own actions
}

export async function notify(n: NotifyInput) {
  try {
    const ids = [...new Set(n.userIds.filter(Boolean).map(String))].filter((id) => id !== String(n.actorId ?? ''));
    if (!ids.length) return;
    const docs = await Notification.insertMany(
      ids.map((userId) => ({ workspaceId: n.workspaceId, userId, type: n.type, title: n.title, body: n.body || '', link: n.link || '' })),
    );
    for (const d of docs) emitToUser(d.userId, 'notification:new', d.toJSON());
  } catch (e) {
    logger.error('notify failed', { err: String(e) });
  }
}
