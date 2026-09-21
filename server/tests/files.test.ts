import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setup, teardown, app, signup, makeProject, upgrade, type Actor } from './helpers';
import { drain } from '../src/jobs/queue';
import { storage, StorageNotFound } from '../src/services/storage';
import { DocumentModel } from '../src/models/Knowledge';
import { Message } from '../src/models/Chat';

// These go through the app, so they exercise whichever storage driver the environment selects
// (local by default; set STORAGE_DRIVER=s3 and the S3_* variables to run them against a bucket).
beforeAll(setup);
afterAll(teardown);

const TEXT = 'Requirements. Authentication tokens should expire after fifteen minutes.';

const upload = (a: Actor, name: string, content: Buffer | string, projectId?: string) => {
  const r = request(app).post('/api/documents').set(a.wsHeader()).attach('file', Buffer.from(content), name);
  if (projectId) r.field('projectId', projectId);
  return r;
};
const missing = (ref: string) => storage.get(ref).then(() => false, (e) => e instanceof StorageNotFound);
const refOf = async (id: string) => (await DocumentModel.findById(id))!.storagePath;
const general = async (a: Actor) => (await a.get('/channels')).body.data.find((c: any) => c.name === 'general').id as string;

describe('stored files', () => {
  it('round-trips a document: upload, process, download the same bytes, delete', async () => {
    const a = await signup('Files');
    const up = await upload(a, 'spec.txt', TEXT);
    expect(up.status).toBe(201);
    await drain();
    expect((await a.get(`/documents/${up.body.data.id}`)).body.data.status).toBe('READY');

    const dl = await request(app).get(`/api/documents/${up.body.data.id}/download`).set(a.wsHeader()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="spec.txt"/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect((dl.body as Buffer).toString()).toBe(TEXT);

    const ref = await refOf(up.body.data.id);
    expect(await missing(ref)).toBe(false);
    expect((await a.del(`/documents/${up.body.data.id}`)).status).toBe(200);
    expect(await missing(ref)).toBe(true);
    expect((await request(app).get(`/api/documents/${up.body.data.id}/download`).set(a.wsHeader())).status).toBe(404);
  });

  it('answers 404 (not a crash) when the stored file has gone missing', async () => {
    const a = await signup('Gone');
    const up = await upload(a, 'gone.txt', TEXT);
    await drain();
    await storage.remove(await refOf(up.body.data.id));
    const r = await request(app).get(`/api/documents/${up.body.data.id}/download`).set(a.wsHeader());
    expect(r.status).toBe(404);
    expect(r.body.success).toBe(false);
  });

  it('marks a document FAILED when its file is missing at processing time', async () => {
    const a = await signup('Lost');
    const up = await upload(a, 'lost.txt', TEXT);
    await drain(); // let the first run finish so we control the second
    const id = up.body.data.id;
    await storage.remove(await refOf(id));
    const { processDocument } = await import('../src/services/rag/ragService');
    await processDocument({ documentId: id });
    const d = (await a.get(`/documents/${id}`)).body.data;
    expect(d.status).toBe('FAILED');
    expect(d.error).toBeTruthy();
  });

  it('round-trips a chat attachment and deletes it with the message', async () => {
    const a = await signup('Chatty');
    const ch = await general(a);
    const send = await request(app).post(`/api/channels/${ch}/messages`).set(a.wsHeader()).field('text', 'see attached').attach('file', Buffer.from('attachment body'), 'notes.txt');
    expect(send.status).toBe(201);
    const id = send.body.data.id;

    const dl = await request(app).get(`/api/messages/${id}/file`).set(a.wsHeader());
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/notes\.txt/);
    expect(dl.text).toBe('attachment body');

    const ref = (await Message.findById(id))!.attachment!.path!;
    expect(await missing(ref)).toBe(false);
    expect((await a.del(`/messages/${id}`)).status).toBe(200);
    expect(await missing(ref)).toBe(true);
  });

  it('deleting a project removes its documents\' files but not other projects\'', async () => {
    const a = await signup('Proj');
    await upgrade(a, 'pro');
    const keep = await makeProject(a, 'Keep');
    const drop = await makeProject(a, 'Drop');
    const k = await upload(a, 'keep.txt', TEXT, keep.id);
    const d = await upload(a, 'drop.txt', TEXT, drop.id);
    await drain();
    const [kref, dref] = [await refOf(k.body.data.id), await refOf(d.body.data.id)];

    expect((await a.del(`/projects/${drop.id}`)).status).toBe(200);
    expect(await missing(dref)).toBe(true);
    expect(await missing(kref)).toBe(false);
  });

  it('deleting a workspace removes all of its files and none of another workspace\'s', async () => {
    const a = await signup('Doomed');
    const b = await signup('Bystander');
    const ad = await upload(a, 'a.txt', TEXT);
    const bd = await upload(b, 'b.txt', TEXT);
    const msg = await request(app).post(`/api/channels/${await general(a)}/messages`).set(a.wsHeader()).field('text', 'x').attach('file', Buffer.from('chat file'), 'c.txt');
    await drain();
    const [aref, bref] = [await refOf(ad.body.data.id), await refOf(bd.body.data.id)];
    const cref = (await Message.findById(msg.body.data.id))!.attachment!.path!;

    const del = await request(app).delete(`/api/workspaces/${a.workspaceId}`).set(a.wsHeader()).send({ confirmName: 'Doomed WS' });
    expect(del.status).toBe(200);
    expect(await missing(aref)).toBe(true);
    expect(await missing(cref)).toBe(true);
    expect(await missing(bref)).toBe(false);
  });
});
