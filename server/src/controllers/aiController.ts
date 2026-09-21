import { Request, Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { AiConversation } from '../models/Knowledge';
import { body, ok, oid, pid } from '../utils/http';
import { notFound } from '../utils/errors';
import * as copilot from '../services/ai/copilot';
import { Project } from '../models/Project';

const id = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

async function assertProject(req: Request, projectId?: string) {
  if (!projectId) return undefined;
  if (!(await Project.exists({ _id: projectId, workspaceId: req.ctx!.workspaceId }))) throw notFound('Project', 'PROJECT_NOT_FOUND');
  return new Types.ObjectId(projectId);
}

export async function chat(req: Request, res: Response) {
  const { message, conversationId } = body(z.object({ message: z.string().trim().min(1).max(4000), conversationId: id.optional() }), req);
  const { workspace, workspaceId } = req.ctx!;
  const userId = req.user!._id;

  const convo = conversationId
    ? await AiConversation.findOne({ _id: oid(conversationId), workspaceId, userId })
    : new AiConversation({ workspaceId, userId, title: message.slice(0, 60) });
  if (!convo) throw notFound('Conversation');

  const r = await copilot.chat({ workspace, userId, message, history: convo.messages.map((m) => ({ role: m.role || 'user', content: m.content || '' })) });
  convo.messages.push({ role: 'user', content: message, at: new Date() } as any);
  convo.messages.push({ role: 'assistant', content: r.answer, sources: r.sources, at: new Date() } as any);
  await convo.save();
  res.json(ok({ conversationId: String(convo._id), answer: r.answer, sources: r.sources, mode: r.mode }));
}

export async function listConversations(req: Request, res: Response) {
  const cs = await AiConversation.find({ workspaceId: req.ctx!.workspaceId, userId: req.user!._id }).sort({ updatedAt: -1 }).limit(50).select('title updatedAt');
  res.json(ok(cs));
}

export async function getConversation(req: Request, res: Response) {
  const c = await AiConversation.findOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId, userId: req.user!._id });
  if (!c) throw notFound('Conversation');
  res.json(ok(c));
}

export async function deleteConversation(req: Request, res: Response) {
  await AiConversation.deleteOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId, userId: req.user!._id });
  res.json(ok({ deleted: true }));
}

export async function summarize(req: Request, res: Response) {
  const input = body(z.object({ projectId: id.optional(), documentId: id.optional(), text: z.string().max(60000).optional() }), req);
  const r = await copilot.summarize({
    workspace: req.ctx!.workspace,
    projectId: input.projectId ? new Types.ObjectId(input.projectId) : undefined,
    documentId: input.documentId ? new Types.ObjectId(input.documentId) : undefined,
    text: input.text,
  });
  res.json(ok(r));
}

export async function generateTasks(req: Request, res: Response) {
  const input = body(z.object({ text: z.string().max(60000).optional(), documentId: id.optional() }), req);
  const r = await copilot.generateTasks({ workspace: req.ctx!.workspace, text: input.text, documentId: input.documentId ? new Types.ObjectId(input.documentId) : undefined });
  res.json(ok(r));
}

export async function documentQuery(req: Request, res: Response) {
  const input = body(z.object({ question: z.string().trim().min(2).max(2000), projectId: id.optional(), documentIds: z.array(id).max(20).optional() }), req);
  const r = await copilot.documentQuery({
    workspace: req.ctx!.workspace,
    question: input.question,
    projectId: await assertProject(req, input.projectId),
    documentIds: input.documentIds?.map((d) => new Types.ObjectId(d)),
  });
  res.json(ok(r));
}

export async function insights(req: Request, res: Response) {
  const input = body(z.object({ projectId: id.optional() }), req);
  res.json(ok(await copilot.insights({ workspace: req.ctx!.workspace, projectId: await assertProject(req, input.projectId) })));
}
