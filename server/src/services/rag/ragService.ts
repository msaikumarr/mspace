import { storage } from '../storage';
import { Types } from 'mongoose';
import { DocumentModel, DocChunk } from '../../models/Knowledge';
import { extractPages } from './extract';
import { chunkPages } from './chunker';
import { embed, cosine } from './embeddings';
import { logger } from '../../utils/logger';

/** Background job: extract -> clean -> chunk -> embed -> store, updating document status as it goes. */
export async function processDocument({ documentId }: { documentId: string }) {
  const doc = await DocumentModel.findById(documentId);
  if (!doc) return;
  try {
    doc.status = 'PROCESSING';
    await doc.save();
    const buffer = await storage.get(doc.storagePath);
    const pages = await extractPages(buffer, doc.ext || 'txt');
    if (!pages.length) throw new Error('No extractable text found (is this a scanned/image-only file?)');
    const chunks = chunkPages(pages);
    await DocChunk.deleteMany({ workspaceId: doc.workspaceId, documentId: doc._id });
    await DocChunk.insertMany(chunks.map((c) => ({ workspaceId: doc.workspaceId, documentId: doc._id, ...c, embedding: embed(c.text) })));
    doc.pageCount = pages.length;
    doc.chunkCount = chunks.length;
    doc.status = 'READY';
    doc.error = undefined;
    await doc.save();
  } catch (e: any) {
    logger.error('document processing failed', { documentId, err: String(e?.message || e) });
    doc.status = 'FAILED';
    doc.error = String(e?.message || e).slice(0, 300);
    await doc.save();
    // failures are recorded on the document; don't retry a deterministic failure
  }
}

export interface Hit {
  documentId: string;
  name: string;
  pageNumber: number;
  chunkIndex: number;
  text: string;
  score: number;
}

/**
 * Similarity search. Tenant isolation is enforced by always filtering on workspaceId in the DB query.
 * (Brute-force cosine in-process; for large corpora swap for MongoDB Atlas Vector Search / pgvector.)
 */
export async function search(workspaceId: Types.ObjectId, queryText: string, k = 5, opts: { projectId?: Types.ObjectId; documentIds?: Types.ObjectId[] } = {}): Promise<Hit[]> {
  const docFilter: Record<string, unknown> = { workspaceId, status: 'READY' };
  if (opts.projectId) docFilter.projectId = opts.projectId;
  if (opts.documentIds) docFilter._id = { $in: opts.documentIds };
  const docs = await DocumentModel.find(docFilter).select('name');
  if (!docs.length) return [];
  const names = new Map(docs.map((d) => [String(d._id), d.name]));
  const q = embed(queryText);
  const chunks = await DocChunk.find({ workspaceId, documentId: { $in: docs.map((d) => d._id) } }).select('+embedding');
  return chunks
    .map((c) => ({ c, score: cosine(q, c.embedding as number[]) }))
    .filter((x) => x.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ c, score }) => ({
      documentId: String(c.documentId),
      name: names.get(String(c.documentId)) || 'Document',
      pageNumber: c.pageNumber,
      chunkIndex: c.chunkIndex,
      text: c.text,
      score: Math.round(score * 1000) / 1000,
    }));
}
