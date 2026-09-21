import { useAuth } from '../store/auth';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

interface Opts {
  method?: string;
  body?: unknown;
  form?: FormData;
  /** Skip the X-Workspace-Id header (account-level endpoints). */
  noWorkspace?: boolean;
  workspaceId?: string;
}

let refreshing: Promise<boolean> | null = null;

/**
 * Exchanges the httpOnly refresh cookie for a new access token. Concurrent callers share one request, which is right for a
 * burst of 401s but wrong when the caller knows something just changed on the server (an address was confirmed, a plan
 * changed): a request already in flight may predate the change. `fresh` waits for that one to finish, then asks again.
 */
export async function refreshSession(opts: { fresh?: boolean } = {}): Promise<boolean> {
  if (opts.fresh && refreshing) {
    await refreshing.catch(() => false);
    refreshing = null;
  }
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) return false;
      const { data } = await res.json();
      useAuth.getState().setSession(data);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function raw(path: string, o: Opts) {
  const { accessToken, workspaceId } = useAuth.getState();
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const ws = o.workspaceId || workspaceId;
  if (ws && !o.noWorkspace) headers['X-Workspace-Id'] = ws;
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
  return fetch(`/api${path}`, { method: o.method || 'GET', headers, body, credentials: 'include' });
}

export async function apiRaw(path: string, o: Opts = {}) {
  let res = await raw(path, o);
  if (res.status === 401 && !path.startsWith('/auth/') && (await refreshSession())) res = await raw(path, o);
  return res;
}

export async function api<T = any>(path: string, o: Opts = {}): Promise<T> {
  const res = await apiRaw(path, o);
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || json?.success === false) {
    if (res.status === 401 && !path.startsWith('/auth/login')) useAuth.getState().clear();
    throw new ApiError(res.status, json?.error?.code || 'ERROR', json?.error?.message || `Request failed (${res.status})`);
  }
  return json.data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body ?? {} });
export const patch = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body: body ?? {} });
export const del = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'DELETE', body });

/** Authenticated download (files are tenant-protected, so a plain <a href> can't be used). */
export async function download(path: string, filename: string) {
  const res = await apiRaw(path);
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Could not download file');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
