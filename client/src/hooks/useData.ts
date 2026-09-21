import { useQuery } from '@tanstack/react-query';
import { get } from '../services/api';
import { useAuth } from '../store/auth';
import type { MemberRow, Project, Task } from '../types';

/** All tenant-scoped query keys start with ['ws', workspaceId] so switching workspace never shows stale data. */
export const useWsKey = () => {
  const id = useAuth((s) => s.workspaceId);
  return (...k: unknown[]) => ['ws', id, ...k];
};

export function useMembers() {
  const key = useWsKey();
  const q = useQuery({
    queryKey: key('members'),
    queryFn: () => get<MemberRow[]>(`/workspaces/${useAuth.getState().workspaceId}/members`),
    enabled: !!useAuth.getState().workspaceId,
  });
  const byId = new Map((q.data || []).map((m) => [m.user.id, m.user]));
  return { ...q, members: q.data || [], byId };
}

export function useProjects() {
  const key = useWsKey();
  return useQuery({ queryKey: key('projects'), queryFn: () => get<Project[]>('/projects') });
}

export function useTasks(params: Record<string, string> = {}) {
  const key = useWsKey();
  const qs = new URLSearchParams(params).toString();
  return useQuery({ queryKey: key('tasks', params), queryFn: () => get<Task[]>(`/tasks${qs ? '?' + qs : ''}`) });
}

export function useBilling() {
  const key = useWsKey();
  return useQuery({ queryKey: key('billing'), queryFn: () => get<any>('/billing') });
}
