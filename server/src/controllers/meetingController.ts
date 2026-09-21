import { Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { Types, type InferSchemaType } from 'mongoose';
import { Meeting } from '../models/Knowledge';
import type { HydratedDocument } from 'mongoose';
import { Usage } from '../models/Misc';
import { Project } from '../models/Project';
import { env } from '../config/env';
import { body, ok, pid } from '../utils/http';
import { AppError, notFound, badRequest, conflict } from '../utils/errors';
import { enqueue, registerJob, type JobContext } from '../jobs/queue';
import { storage, StorageNotFound } from '../services/storage';
import { AUDIO_FORMATS, TranscriptionError, audioMime, sniffAudio, transcribe, transcriptionCredits, transcriptionEnabled } from '../services/ai/transcribe';
import { assertAiQuota, recordUsage } from '../services/billing/usageService';
import { analyzeTranscript, resolveCandidates } from '../services/ai/copilot';
import { createTasks } from '../services/taskService';
import { audit } from '../services/auditService';
import { emitToWorkspace } from '../sockets';
import { logger } from '../utils/logger';

type MeetingDoc = HydratedDocument<InferSchemaType<typeof Meeting.schema>>;
const MAX_TRANSCRIPT_CHARS = 100_000; // same ceiling as a pasted transcript
const announce = (m: MeetingDoc) => emitToWorkspace(m.workspaceId, 'meeting:updated', m.toJSON());

/**
 * Turns a recording into a transcript. Returns false when it has failed for good (recorded on the meeting, credit
 * refunded, recording discarded) and throws for a failure that is worth another attempt.
 */
async function transcribeMeeting(m: MeetingDoc, ctx: JobContext) {
  const ref = m.audio?.ref;
  try {
    if (m.status !== 'TRANSCRIBING') {
      m.status = 'TRANSCRIBING';
      await m.save();
      announce(m);
    }
    if (!ref) throw new TranscriptionError('The recording is no longer available. Please upload it again.', false);
    let audio: Buffer;
    try {
      audio = await storage.get(ref);
    } catch (e) {
      throw e instanceof StorageNotFound ? new TranscriptionError('The recording is no longer available. Please upload it again.', false) : e;
    }
    const { text } = await transcribe(audio, m.audio?.name || 'recording', audioMime(m.audio?.name || ''));
    m.transcript = text.slice(0, MAX_TRANSCRIPT_CHARS);
    m.status = 'PROCESSING';
    m.set('audio.ref', undefined);
    await m.save();
    // Voice recordings are sensitive and cheap to keep only briefly: the transcript is what the product works from.
    await storage.remove(ref).catch((e) => logger.warn('could not delete transcribed recording', { meetingId: String(m._id), err: String(e) }));
    announce(m);
    return true;
  } catch (e) {
    const retryable = e instanceof TranscriptionError ? e.retryable : !(e instanceof StorageNotFound);
    if (retryable && ctx.attempt < ctx.maxAttempts) throw e; // the queue will try again
    logger.error('transcription failed', { meetingId: String(m._id), attempt: ctx.attempt, err: String(e) });
    m.status = 'FAILED';
    m.error = e instanceof TranscriptionError ? e.message : 'Transcription failed unexpectedly. Please try again.';
    m.set('audio.ref', undefined);
    await m.save();
    if (m.usageId) await Usage.deleteOne({ _id: m.usageId }).catch(() => undefined); // a failed recording does not cost credits
    if (ref) await storage.remove(ref).catch(() => undefined);
    announce(m);
    return false;
  }
}

registerJob('meeting.process', async ({ meetingId }: { meetingId: string }, ctx) => {
  const m = await Meeting.findById(meetingId).select('+audio.ref +usageId');
  if (!m) return;
  if (m.source === 'audio' && !m.transcript && !(await transcribeMeeting(m, ctx))) return;
  try {
    const a = await analyzeTranscript(m.transcript);
    const items = await resolveCandidates(m.workspaceId, a.actionItems);
    m.summary = a.summary;
    m.decisions = a.decisions as any;
    m.deadlines = a.deadlines as any;
    m.actionItems = items.map((i) => ({ title: i.title, description: i.description, priority: i.priority, assigneeName: i.assigneeName, assigneeId: i.assigneeId, dueDate: i.dueDate ? new Date(i.dueDate) : undefined })) as any;
    m.status = 'READY';
  } catch (e) {
    logger.error('meeting processing failed', { meetingId, err: String(e) });
    m.status = 'FAILED';
    m.error = 'The transcript could not be analysed. Please try again.';
  }
  await m.save();
  announce(m);
});

/** What this server can do, so the UI only offers recording upload when transcription is set up. */
export function capabilities(_req: Request, res: Response) {
  res.json(ok({ audio: { enabled: transcriptionEnabled(), maxMb: env.MAX_AUDIO_MB, formats: AUDIO_FORMATS, credits: transcriptionCredits() } }));
}

export const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_AUDIO_MB * 1024 * 1024, files: 1 } }).single('audio');

/** Creates a meeting from a recording; a background job transcribes it and then analyses the transcript like a pasted one. */
export async function createFromAudio(req: Request, res: Response) {
  if (!transcriptionEnabled()) throw new AppError(503, 'TRANSCRIPTION_NOT_CONFIGURED', 'Audio transcription is not set up on this server. Paste a transcript instead.');
  const input = body(z.object({ title: z.string().trim().min(1).max(150), projectId: z.string().optional() }), req);
  const file = req.file;
  if (!file) throw badRequest('Attach a recording in the "audio" field', 'NO_FILE');
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  if (!(AUDIO_FORMATS as readonly string[]).includes(ext)) throw badRequest(`Unsupported audio type ".${ext}". Allowed: ${AUDIO_FORMATS.join(', ')}`, 'UNSUPPORTED_TYPE');
  if (!file.size) throw badRequest('File is empty', 'EMPTY_FILE');
  if (!sniffAudio(file.buffer, ext)) throw badRequest('File content does not match its extension', 'CONTENT_MISMATCH');
  const { workspace, workspaceId } = req.ctx!;
  if (input.projectId && !(await Project.exists({ _id: input.projectId, workspaceId }))) throw notFound('Project', 'PROJECT_NOT_FOUND');

  const credits = transcriptionCredits();
  await assertAiQuota(workspace, credits);
  const usage = await recordUsage(workspaceId, req.user!._id, 'meeting.transcribe', credits);
  const refund = () => Usage.deleteOne({ _id: usage._id }).catch(() => undefined);

  const id = new Types.ObjectId();
  const name = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200);
  let ref: string;
  try {
    ref = await storage.put(`${workspaceId}/audio/${id}.${ext}`, file.buffer, audioMime(name));
  } catch (e) {
    await refund();
    throw e;
  }
  const m = await Meeting.create({
    _id: id, workspaceId, projectId: input.projectId || null, title: input.title, source: 'audio', status: 'TRANSCRIBING',
    audio: { ref, name, size: file.size }, usageId: usage._id, createdBy: req.user!._id,
  });
  try {
    await enqueue('meeting.process', { meetingId: String(id) });
  } catch (e) {
    logger.error('could not queue transcription', { meetingId: String(id), err: String(e) });
    m.status = 'FAILED';
    m.error = 'Transcription could not be queued. Please try again.';
    m.set('audio.ref', undefined);
    await m.save();
    await refund();
    await storage.remove(ref).catch(() => undefined);
  }
  res.status(202).json(ok(m));
}

export async function create(req: Request, res: Response) {
  const input = body(z.object({ title: z.string().trim().min(1).max(150), transcript: z.string().trim().min(20, 'Transcript is too short').max(100000), projectId: z.string().optional() }), req);
  const { workspaceId } = req.ctx!;
  if (input.projectId && !(await Project.exists({ _id: input.projectId, workspaceId }))) throw notFound('Project', 'PROJECT_NOT_FOUND');
  const m = await Meeting.create({ workspaceId, projectId: input.projectId || null, title: input.title, transcript: input.transcript, createdBy: req.user!._id });
  try {
    await enqueue('meeting.process', { meetingId: String(m._id) });
  } catch (e) {
    logger.error('could not queue meeting processing', { meetingId: String(m._id), err: String(e) });
    m.status = 'FAILED';
    await m.save();
  }
  res.status(202).json(ok(m));
}

export async function list(req: Request, res: Response) {
  res.json(ok(await Meeting.find({ workspaceId: req.ctx!.workspaceId }).sort({ createdAt: -1 }).select('-transcript').limit(100)));
}

export async function get(req: Request, res: Response) {
  const m = await Meeting.findOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId });
  if (!m) throw notFound('Meeting');
  res.json(ok(m));
}

/** Human approval step: only the action items the reviewer selects become tasks. */
export async function approve(req: Request, res: Response) {
  const { projectId, items } = body(
    z.object({
      projectId: z.string(),
      items: z.array(z.object({ index: z.number().int().min(0), title: z.string().trim().min(1).max(200).optional(), assigneeId: z.string().nullable().optional(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(), dueDate: z.coerce.date().nullable().optional() })).min(1).max(50),
    }),
    req,
  );
  const { workspaceId } = req.ctx!;
  const m = await Meeting.findOne({ _id: pid(req), workspaceId });
  if (!m) throw notFound('Meeting');
  if (m.status !== 'READY') throw badRequest('Meeting is still processing', 'NOT_READY');
  const chosen = items.map((i) => {
    const a = m.actionItems[i.index];
    if (!a) throw badRequest(`No action item at index ${i.index}`, 'INVALID_INDEX');
    if (a.approved) throw conflict(`"${a.title}" was already approved`, 'ALREADY_APPROVED');
    return { i, a };
  });
  const tasks = await createTasks(
    workspaceId,
    req.user!,
    new Types.ObjectId(projectId),
    chosen.map(({ i, a }) => ({
      title: i.title || a.title || 'Untitled',
      description: `From meeting "${m.title}". ${a.description || ''}`.trim(),
      priority: i.priority || a.priority || 'MEDIUM',
      assigneeId: i.assigneeId !== undefined ? i.assigneeId : a.assigneeId ? String(a.assigneeId) : null,
      dueDate: i.dueDate !== undefined ? i.dueDate : a.dueDate || null,
    })),
    'meeting',
  );
  chosen.forEach(({ a }, n) => {
    a.approved = true;
    a.taskId = tasks[n]._id;
  });
  await m.save();
  await audit({ workspaceId, actorId: req.user!._id, action: 'AI_TASKS_APPROVED', targetType: 'meeting', targetId: String(m._id), metadata: { count: tasks.length } });
  res.status(201).json(ok({ tasks, meeting: m }));
}

export async function remove(req: Request, res: Response) {
  const m = await Meeting.findOneAndDelete({ _id: pid(req), workspaceId: req.ctx!.workspaceId }).select('+audio.ref');
  if (m?.audio?.ref) await storage.remove(m.audio.ref).catch(() => undefined); // deleted mid-transcription
  res.json(ok({ deleted: true }));
}
