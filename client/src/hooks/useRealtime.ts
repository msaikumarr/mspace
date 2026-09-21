import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connectSocket, joinWorkspace, disconnectSocket } from '../services/socket';
import { useAuth } from '../store/auth';
import { get } from '../services/api';
import { toast } from '../components/ui';
import type { Notification, Workspace } from '../types';

/** Mounted once in the app shell: keeps the socket alive and turns server events into cache updates. */
export function useRealtime() {
  const qc = useQueryClient();
  const workspaceId = useAuth((s) => s.workspaceId);
  const userId = useAuth((s) => s.user?.id);

  useEffect(() => {
    const s = connectSocket();
    const inv = (...k: unknown[]) => qc.invalidateQueries({ queryKey: ['ws', useAuth.getState().workspaceId, ...k] });
    const on = (ev: string, fn: (...a: any[]) => void) => s.on(ev, fn);
    on('task:created', () => { inv('tasks'); inv('analytics'); inv('projects'); });
    on('task:updated', () => { inv('tasks'); inv('analytics'); inv('projects'); inv('comments'); });
    on('task:deleted', () => { inv('tasks'); inv('analytics'); inv('projects'); });
    on('project:created', () => inv('projects'));
    on('project:updated', () => inv('projects'));
    on('project:deleted', () => { inv('projects'); inv('tasks'); });
    on('comment:new', () => inv('comments'));
    on('document:updated', () => inv('documents'));
    on('document:deleted', () => inv('documents'));
    on('meeting:updated', () => inv('meetings'));
    on('member:joined', () => inv('members'));
    on('notification:new', (n: Notification) => {
      inv('notifications');
      toast.info(n.title);
    });
    on('dm:new', () => inv('channels'));
    // a webhook changed this workspace's plan: refresh the plan shown in the sidebar and on the billing page
    on('billing:updated', () => {
      get<Workspace[]>('/workspaces').then((w) => useAuth.getState().setWorkspaces(w)).catch(() => undefined);
      inv('billing'); inv('analytics');
    });
    return () => { ['task:created', 'task:updated', 'task:deleted', 'project:created', 'project:updated', 'project:deleted', 'comment:new', 'document:updated', 'document:deleted', 'meeting:updated', 'member:joined', 'notification:new', 'dm:new', 'billing:updated'].forEach((e) => s.off(e)); };
  }, [qc, userId]);

  useEffect(() => {
    if (workspaceId) joinWorkspace(workspaceId);
  }, [workspaceId]);

  useEffect(() => () => disconnectSocket(), []);
}
