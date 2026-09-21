import { Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { Types } from 'mongoose';
import { Channel, Message } from '../models/Chat';
import { Notification } from '../models/Misc';
import { Member } from '../models/Workspace';
import { body, ok, pid, query } from '../utils/http';
import { notFound, forbidden, badRequest } from '../utils/errors';
import { emitToChannel, emitToUser } from '../sockets';
import { notify } from '../services/notifications/notificationService';
import { dmKey } from '../services/workspaceService';
import { can } from '../config/rbac';
import { storage, readOr404 } from '../services/storage';
import { env } from '../config/env';

export const chatUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 } }).single('file');

async function accessibleChannel(req: Request, id: Types.ObjectId) {
  const ch = await Channel.findOne({ _id: id, workspaceId: req.ctx!.workspaceId });
  if (!ch) throw notFound('Channel');
  if (ch.type === 'dm' && !ch.participantIds.some((p) => String(p) === String(req.user!._id))) throw notFound('Channel');
  return ch;
}

export async function listChannels(req: Request, res: Response) {
  const { workspaceId } = req.ctx!;
  const chs = await Channel.find({ workspaceId, $or: [{ type: 'channel' }, { participantIds: req.user!._id }] }).sort({ type: 1, name: 1 });
  const unread = await Message.aggregate([
    { $match: { workspaceId, channelId: { $in: chs.map((c) => c._id) }, userId: { $ne: req.user!._id }, readBy: { $ne: req.user!._id }, deleted: false } },
    { $group: { _id: '$channelId', n: { $sum: 1 } } },
  ]);
  const u = new Map(unread.map((x) => [String(x._id), x.n as number]));
  res.json(ok(chs.map((c) => ({ ...c.toJSON(), unread: u.get(String(c._id)) || 0 }))));
}

export async function createChannel(req: Request, res: Response) {
  const { name } = body(z.object({ name: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,29}$/, 'Use lowercase letters, numbers and dashes') }), req);
  const ch = await Channel.create({ workspaceId: req.ctx!.workspaceId, name, createdBy: req.user!._id });
  res.status(201).json(ok(ch));
}

export async function openDm(req: Request, res: Response) {
  const { userId } = body(z.object({ userId: z.string() }), req);
  const { workspaceId } = req.ctx!;
  if (userId === String(req.user!._id)) throw badRequest('Cannot DM yourself');
  if (!(await Member.exists({ workspaceId, userId }))) throw notFound('Member');
  const key = dmKey(req.user!._id, userId);
  const ch =
    (await Channel.findOne({ workspaceId, dmKey: key })) ||
    (await Channel.create({ workspaceId, type: 'dm', name: 'dm', dmKey: key, participantIds: [req.user!._id, userId], createdBy: req.user!._id }));
  res.json(ok(ch));
}

const shape = (m: any) => ({ ...m.toJSON(), user: m.userId && m.userId.name ? { id: String(m.userId._id), name: m.userId.name, avatarColor: m.userId.avatarColor } : undefined, userId: String(m.userId?._id ?? m.userId) });

export async function listMessages(req: Request, res: Response) {
  const ch = await accessibleChannel(req, pid(req));
  const q = query(z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req);
  const f: Record<string, unknown> = { workspaceId: req.ctx!.workspaceId, channelId: ch._id };
  if (q.before) f.createdAt = { $lt: new Date(q.before) };
  const msgs = await Message.find(f).sort({ createdAt: -1 }).limit(q.limit).populate('userId', 'name avatarColor');
  res.json(ok(msgs.reverse().map(shape)));
}

export async function sendMessage(req: Request, res: Response) {
  const ch = await accessibleChannel(req, pid(req));
  const { workspaceId } = req.ctx!;
  const input = body(z.object({ text: z.string().max(8000).default(''), replyTo: z.string().nullable().optional(), mentions: z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(z.string()).max(20).optional()) }), req);
  const file = req.file;
  if (!input.text.trim() && !file) throw badRequest('Message is empty', 'EMPTY_MESSAGE');
  if (input.replyTo && !(await Message.exists({ _id: input.replyTo, channelId: ch._id }))) throw badRequest('Reply target not found', 'INVALID_REPLY');

  const mentions = input.mentions?.length ? (await Member.find({ workspaceId, userId: { $in: input.mentions } })).map((m) => m.userId) : [];
  const msg = new Message({ workspaceId, channelId: ch._id, userId: req.user!._id, text: input.text, replyTo: input.replyTo || null, mentions, readBy: [req.user!._id] });
  if (file) {
    const ext = path.extname(file.originalname).slice(0, 10).replace(/[^.a-zA-Z0-9]/g, '');
    const ref = await storage.put(`${workspaceId}/chat/${msg._id}${ext}`, file.buffer, file.mimetype);
    msg.attachment = { name: file.originalname, url: `/api/messages/${msg._id}/file`, path: ref, mime: file.mimetype };
  }
  await msg.save();
  await msg.populate('userId', 'name avatarColor');
  const payload = shape(msg);
  emitToChannel(ch._id, 'message:new', payload);

  const link = `/app/chat?channel=${ch._id}`;
  await notify({ workspaceId, userIds: mentions, type: 'MENTION', title: `${req.user!.name} mentioned you in ${ch.type === 'dm' ? 'a DM' : '#' + ch.name}`, body: input.text.slice(0, 140), link, actorId: req.user!._id });
  if (ch.type === 'dm') {
    for (const u of ch.participantIds) if (String(u) !== String(req.user!._id)) emitToUser(u, 'dm:new', { channelId: String(ch._id), message: payload });
  }
  res.status(201).json(ok(payload));
}

async function ownMessage(req: Request) {
  const m = await Message.findOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId });
  if (!m) throw notFound('Message');
  await accessibleChannel(req, m.channelId);
  return m;
}

export async function editMessage(req: Request, res: Response) {
  const { text } = body(z.object({ text: z.string().trim().min(1).max(8000) }), req);
  const m = await ownMessage(req);
  if (String(m.userId) !== String(req.user!._id) || m.deleted) throw forbidden('You can only edit your own messages', 'NOT_AUTHOR');
  m.text = text;
  m.editedAt = new Date();
  await m.save();
  await m.populate('userId', 'name avatarColor');
  emitToChannel(m.channelId, 'message:updated', shape(m));
  res.json(ok(shape(m)));
}

export async function deleteMessage(req: Request, res: Response) {
  const m = await ownMessage(req);
  const isAuthor = String(m.userId) === String(req.user!._id);
  if (!isAuthor && !can(req.ctx!.role, 'task:delete')) throw forbidden('You cannot delete this message', 'NOT_AUTHOR');
  m.deleted = true;
  m.text = '';
  if (m.attachment?.path) await storage.remove(m.attachment.path);
  m.attachment = undefined;
  await m.save();
  emitToChannel(m.channelId, 'message:deleted', { id: String(m._id), channelId: String(m.channelId) });
  res.json(ok({ deleted: true }));
}

export async function react(req: Request, res: Response) {
  const { emoji } = body(z.object({ emoji: z.string().min(1).max(8) }), req);
  const m = await ownMessage(req);
  const uid = req.user!._id;
  let r = m.reactions.find((x) => x.emoji === emoji);
  if (!r) {
    m.reactions.push({ emoji, userIds: [uid] } as any);
  } else if (r.userIds.some((u) => String(u) === String(uid))) {
    r.userIds = r.userIds.filter((u) => String(u) !== String(uid)) as any;
    if (!r.userIds.length) m.reactions = m.reactions.filter((x) => x.emoji !== emoji) as any;
  } else r.userIds.push(uid);
  await m.save();
  emitToChannel(m.channelId, 'message:reactions', { id: String(m._id), channelId: String(m.channelId), reactions: m.toJSON().reactions });
  res.json(ok(m.toJSON().reactions));
}

export async function markRead(req: Request, res: Response) {
  const ch = await accessibleChannel(req, pid(req));
  await Message.updateMany({ workspaceId: req.ctx!.workspaceId, channelId: ch._id, readBy: { $ne: req.user!._id } }, { $addToSet: { readBy: req.user!._id } });
  emitToChannel(ch._id, 'channel:read', { channelId: String(ch._id), userId: String(req.user!._id) });
  res.json(ok({ read: true }));
}

export async function downloadFile(req: Request, res: Response) {
  const m = await ownMessage(req);
  if (!m.attachment?.path) throw notFound('File');
  const data = await readOr404(m.attachment.path);
  res.setHeader('Content-Type', m.attachment.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(m.attachment.name || 'file')}"`);
  res.send(data);
}

export async function listNotifications(req: Request, res: Response) {
  const f = { workspaceId: req.ctx!.workspaceId, userId: req.user!._id };
  const [items, unread] = await Promise.all([Notification.find(f).sort({ createdAt: -1 }).limit(100), Notification.countDocuments({ ...f, read: false })]);
  res.json(ok({ items, unread }));
}

export async function readNotification(req: Request, res: Response) {
  await Notification.updateOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId, userId: req.user!._id }, { read: true });
  res.json(ok({ read: true }));
}

export async function readAllNotifications(req: Request, res: Response) {
  await Notification.updateMany({ workspaceId: req.ctx!.workspaceId, userId: req.user!._id, read: false }, { read: true });
  res.json(ok({ read: true }));
}
