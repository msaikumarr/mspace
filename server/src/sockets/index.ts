import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { env } from '../config/env';
import { User } from '../models/User';
import { Member } from '../models/Workspace';
import { Channel } from '../models/Chat';
import { logger } from '../utils/logger';
import { can, Role } from '../config/rbac';
import { Types } from 'mongoose';

let io: Server | null = null;
// workspaceId -> userId -> connection count (single-instance presence; with Redis adapter use fetchSockets for accuracy)
const presence = new Map<string, Map<string, number>>();

export const wsRoom = (id: unknown) => `ws:${id}`;
export const userRoom = (id: unknown) => `user:${id}`;
export const chRoom = (id: unknown) => `ch:${id}`;

export const emitToWorkspace = (workspaceId: unknown, event: string, payload: unknown) => io?.to(wsRoom(workspaceId)).emit(event, payload);
export const emitToUser = (userId: unknown, event: string, payload: unknown) => io?.to(userRoom(userId)).emit(event, payload);
export const emitToChannel = (channelId: unknown, event: string, payload: unknown) => io?.to(chRoom(channelId)).emit(event, payload);
export const onlineUsers = (workspaceId: string) => [...(presence.get(workspaceId)?.keys() || [])];

export function initSockets(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.CLIENT_URL.split(','), credentials: true } });

  if (env.REDIS_URL && env.NODE_ENV !== 'test') {
    const pub = new Redis(env.REDIS_URL);
    const sub = pub.duplicate();
    io.adapter(createAdapter(pub, sub));
  }

  // Authenticate every connection with the same JWT as the REST API.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('UNAUTHORIZED'));
      const p = jwt.verify(token, env.JWT_SECRET) as { sub: string; tv: number; typ?: string };
      const user = await User.findById(p.sub);
      if (!user || user.tokenVersion !== p.tv || p.typ !== 'access') return next(new Error('UNAUTHORIZED'));
      socket.data.userId = String(user._id);
      socket.data.name = user.name;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId: string = socket.data.userId;
    socket.join(userRoom(userId));
    const joined = new Set<string>();

    // Client asks to join a workspace; server verifies membership itself (never trust the client).
    socket.on('workspace:join', async (workspaceId: string, ack?: (ok: boolean) => void) => {
      try {
        if (!Types.ObjectId.isValid(workspaceId)) return ack?.(false);
        if (joined.has(workspaceId)) return ack?.(true); // idempotent: repeated joins must not inflate presence counts
        const m = await Member.findOne({ workspaceId, userId });
        if (!m) return ack?.(false);
        if (joined.has(workspaceId)) return ack?.(true); // a concurrent join won the race while we awaited the DB
        socket.join(wsRoom(workspaceId));
        joined.add(workspaceId);
        const map = presence.get(workspaceId) || new Map<string, number>();
        map.set(userId, (map.get(userId) || 0) + 1);
        presence.set(workspaceId, map);
        io!.to(wsRoom(workspaceId)).emit('presence:update', { userId, online: true });
        ack?.(true);
      } catch (e) {
        logger.error('workspace:join failed', { err: String(e) });
        ack?.(false);
      }
    });

    socket.on('presence:list', (workspaceId: string, ack?: (ids: string[]) => void) => {
      ack?.(joined.has(workspaceId) ? onlineUsers(workspaceId) : []);
    });

    socket.on('channel:join', async (channelId: string, ack?: (ok: boolean) => void) => {
      try {
        if (!Types.ObjectId.isValid(channelId)) return ack?.(false);
        const ch = await Channel.findById(channelId);
        if (!ch) return ack?.(false);
        // Authorise from the database (not from client-supplied state) so this cannot race workspace:join.
        const m = await Member.findOne({ workspaceId: ch.workspaceId, userId });
        if (!m || !can(m.role as Role, 'chat:read')) return ack?.(false);
        if (ch.type === 'dm' && !ch.participantIds.some((p) => String(p) === userId)) return ack?.(false);
        socket.join(chRoom(channelId));
        ack?.(true);
      } catch {
        ack?.(false);
      }
    });
    socket.on('channel:leave', (channelId: string) => socket.leave(chRoom(channelId)));

    socket.on('typing', ({ channelId, typing }: { channelId: string; typing: boolean }) => {
      if (!socket.rooms.has(chRoom(channelId))) return; // must have been authorised to join
      socket.to(chRoom(channelId)).emit('typing', { channelId, userId, name: socket.data.name, typing: !!typing });
    });

    const leaveWorkspace = (wsId: string) => {
      if (!joined.delete(wsId)) return;
      socket.leave(wsRoom(wsId));
      const map = presence.get(wsId);
      if (!map) return;
      const n = (map.get(userId) || 1) - 1;
      if (n <= 0) {
        map.delete(userId);
        io?.to(wsRoom(wsId)).emit('presence:update', { userId, online: false });
      } else map.set(userId, n);
    };
    socket.on('workspace:leave', (wsId: string) => leaveWorkspace(wsId));
    socket.on('disconnect', () => [...joined].forEach(leaveWorkspace));
  });
  return io;
}

/** Drops every live connection of a user (e.g. after removal from a workspace); the client reconnects with fresh, re-checked rooms. */
export const disconnectUser = (userId: unknown) => io?.in(userRoom(userId)).disconnectSockets(true);

export async function closeSockets() {
  await io?.close();
  io = null;
  presence.clear();
}
