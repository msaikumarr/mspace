import { io, Socket } from 'socket.io-client';
import { useAuth } from '../store/auth';

let socket: Socket | null = null;
let joined: string | null = null;

/** One shared socket per session. Auth uses the current access token; membership is verified by the server on join. */
export function getSocket(): Socket | null {
  return socket;
}

export function connectSocket(): Socket {
  if (socket) return socket;
  socket = io({
    path: '/socket.io',
    auth: (cb) => cb({ token: useAuth.getState().accessToken }),
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 8000,
  });
  socket.on('connect', () => {
    const ws = useAuth.getState().workspaceId;
    if (ws) joinWorkspace(ws, true);
  });
  return socket;
}

export function joinWorkspace(workspaceId: string, force = false) {
  if (!socket || (joined === workspaceId && !force)) return;
  if (joined && joined !== workspaceId) socket.emit('workspace:leave', joined);
  joined = workspaceId;
  socket.emit('workspace:join', workspaceId);
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
  joined = null;
}
