import { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { Types } from 'mongoose';
import { DocumentModel, DocChunk } from '../models/Knowledge';
import { Project } from '../models/Project';
import { env } from '../config/env';
import { ok, pid } from '../utils/http';
import { badRequest, notFound } from '../utils/errors';
import { ALLOWED_EXT, sniffMatchesExt } from '../services/rag/extract';
import { storage, readOr404 } from '../services/storage';
import { enqueue, registerJob } from '../jobs/queue';
import { processDocument } from '../services/rag/ragService';
import { logger } from '../utils/logger';
import { audit } from '../services/auditService';
import { assertStorage } from '../services/billing/usageService';
import { emitToWorkspace } from '../sockets';

export const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } }).single('file');

const MIME: Record<string, string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown' };

export async function upload(req: Request, res: Response) {
  const file = req.file;
  if (!file) throw badRequest('Attach a file in the "file" field', 'NO_FILE');
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  if (!(ALLOWED_EXT as readonly string[]).includes(ext)) throw badRequest(`Unsupported file type ".${ext}". Allowed: ${ALLOWED_EXT.join(', ')}`, 'UNSUPPORTED_TYPE');
  if (!file.size) throw badRequest('File is empty', 'EMPTY_FILE');
  if (!sniffMatchesExt(file.buffer, ext)) throw badRequest('File content does not match its extension', 'CONTENT_MISMATCH');

  const { workspace, workspaceId } = req.ctx!;
  await assertStorage(workspace, file.size);
  let projectId: Types.ObjectId | null = null;
  if (req.body?.projectId) {
    projectId = new Types.ObjectId(String(req.body.projectId));
    if (!(await Project.exists({ _id: projectId, workspaceId }))) throw notFound('Project', 'PROJECT_NOT_FOUND');
  }

  const id = new Types.ObjectId();
  // key is server-generated: never derived from user input. (`storagePath` holds the storage ref, not necessarily a file path.)
  const storagePath = await storage.put(`${workspaceId}/docs/${id}.${ext}`, file.buffer, MIME[ext]);

  const name = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200);
  const doc = await DocumentModel.create({ _id: id, workspaceId, projectId, name, ext, mimeType: MIME[ext], size: file.size, storagePath, uploadedBy: req.user!._id });
  await audit({ workspaceId, actorId: req.user!._id, action: 'DOCUMENT_UPLOADED', targetType: 'document', targetId: String(id), metadata: { name, size: file.size } });
  try {
    await enqueue('document.process', { documentId: String(id) });
  } catch (e) {
    logger.error('could not queue document processing', { documentId: String(id), err: String(e) });
    doc.status = 'FAILED';
    doc.error = 'Processing could not be queued. Please try uploading again.';
    await doc.save();
  }
  emitToWorkspace(workspaceId, 'document:updated', publicDoc(doc));
  res.status(201).json(ok(publicDoc(doc)));
}

// Runs on whichever instance picks the job up, so it announces completion itself.
registerJob('document.process', async ({ documentId }: { documentId: string }) => {
  await processDocument({ documentId });
  const d = await DocumentModel.findById(documentId);
  if (d) emitToWorkspace(d.workspaceId, 'document:updated', publicDoc(d));
});

const publicDoc = (d: any) => {
  const j = d.toJSON();
  delete j.storagePath;
  return j;
};

export async function list(req: Request, res: Response) {
  const f: Record<string, unknown> = { workspaceId: req.ctx!.workspaceId };
  if (req.query.projectId) f.projectId = new Types.ObjectId(String(req.query.projectId));
  const docs = await DocumentModel.find(f).sort({ createdAt: -1 }).populate('uploadedBy', 'name');
  res.json(ok(docs.map(publicDoc)));
}

export async function get(req: Request, res: Response) {
  const d = await DocumentModel.findOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId });
  if (!d) throw notFound('Document', 'DOCUMENT_NOT_FOUND');
  res.json(ok(publicDoc(d)));
}

export async function download(req: Request, res: Response) {
  const d = await DocumentModel.findOne({ _id: pid(req), workspaceId: req.ctx!.workspaceId });
  if (!d) throw notFound('Document', 'DOCUMENT_NOT_FOUND');
  const data = await readOr404(d.storagePath);
  res.setHeader('Content-Type', d.mimeType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(d.name)}"`);
  res.send(data);
}

export async function remove(req: Request, res: Response) {
  const { workspaceId } = req.ctx!;
  const d = await DocumentModel.findOneAndDelete({ _id: pid(req), workspaceId });
  if (!d) throw notFound('Document', 'DOCUMENT_NOT_FOUND');
  await DocChunk.deleteMany({ workspaceId, documentId: d._id });
  await storage.remove(d.storagePath);
  await audit({ workspaceId, actorId: req.user!._id, action: 'DOCUMENT_DELETED', targetType: 'document', targetId: String(d._id), metadata: { name: d.name } });
  emitToWorkspace(workspaceId, 'document:deleted', { id: String(d._id) });
  res.json(ok({ deleted: true }));
}
