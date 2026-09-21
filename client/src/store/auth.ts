import { create } from 'zustand';
import type { User, Workspace, Role } from '../types';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  workspaces: Workspace[];
  workspaceId: string | null;
  ready: boolean;
  setSession: (s: { user: User; accessToken: string; workspaces: Workspace[] }) => void;
  setToken: (t: string) => void;
  setWorkspaces: (w: Workspace[]) => void;
  selectWorkspace: (id: string) => void;
  clear: () => void;
  setReady: () => void;
}

const KEY = 'mspace.workspaceId';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (v: string | null) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  workspaces: [],
  workspaceId: null,
  ready: false,
  setSession: ({ user, accessToken, workspaces }) => {
    const saved = read();
    const workspaceId = workspaces.find((w) => w.id === (get().workspaceId || saved))?.id ?? workspaces[0]?.id ?? null;
    write(workspaceId);
    set({ user, accessToken, workspaces, workspaceId, ready: true });
  },
  setToken: (accessToken) => set({ accessToken }),
  setWorkspaces: (workspaces) => {
    const cur = get().workspaceId;
    const workspaceId = workspaces.find((w) => w.id === cur)?.id ?? workspaces[0]?.id ?? null;
    write(workspaceId);
    set({ workspaces, workspaceId });
  },
  selectWorkspace: (id) => { write(id); set({ workspaceId: id }); },
  clear: () => { write(null); set({ user: null, accessToken: null, workspaces: [], workspaceId: null, ready: true }); },
  setReady: () => set({ ready: true }),
}));

export const useWorkspace = () => {
  const { workspaces, workspaceId } = useAuth();
  return workspaces.find((w) => w.id === workspaceId) || null;
};

const RANK: Role[] = ['owner', 'admin', 'manager', 'member', 'viewer'];
/** True when the current role is at least `min` (UI affordance only; the server enforces every permission). */
export const useRoleAtLeast = (min: Role) => {
  const ws = useWorkspace();
  return !!ws && RANK.indexOf(ws.role) <= RANK.indexOf(min);
};
