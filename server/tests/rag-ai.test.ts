import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setup, teardown, app, signup, makeProject, upgrade, addMember, Actor } from './helpers';
import { drain } from '../src/jobs/queue';
import { embed, cosine } from '../src/services/rag/embeddings';
import { chunkPages } from '../src/services/rag/chunker';

beforeAll(setup);
afterAll(teardown);

const REQS = `Requirements Specification

The system must support single sign-on using SAML for enterprise customers. Authentication tokens should expire after fifteen minutes.

Billing. Invoices are generated on the first day of each month. The finance team needs to export invoices as CSV. Payment retries happen three times over seven days.

Performance. The dashboard must load in under two seconds for workspaces with ten thousand tasks. The team should implement pagination for the audit log.`;

function upload(a: Actor, name: string, content: string | Buffer, projectId?: string) {
  const r = request(app).post('/api/documents').set(a.wsHeader()).attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), name);
  if (projectId) r.field('projectId', projectId);
  return r;
}

describe('embeddings & chunking', () => {
  it('ranks related text above unrelated text', () => {
    const q = embed('how long until authentication tokens expire');
    const rel = cosine(q, embed('Authentication tokens should expire after fifteen minutes.'));
    const unrel = cosine(q, embed('Invoices are generated on the first day of each month.'));
    expect(rel).toBeGreaterThan(unrel + 0.1);
    expect(embed('hello world')).toHaveLength(512);
  });

  it('chunks by sentence with page metadata and overlap', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about topic ${i % 5}.`).join(' ');
    const chunks = chunkPages([{ pageNumber: 3, text }], 300, 60);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.pageNumber === 3 && c.text.length <= 460)).toBe(true);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});

describe('documents + RAG', () => {
  it('validates uploads (type, magic bytes, empty)', async () => {
    const a = await signup('Up');
    expect((await upload(a, 'evil.exe', 'MZ...')).status).toBe(400);
    const fake = await upload(a, 'fake.pdf', 'this is not a pdf');
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('CONTENT_MISMATCH');
    expect((await upload(a, 'empty.txt', '')).status).toBeGreaterThanOrEqual(400);
    expect((await a.post('/documents', {})).status).toBe(400);
  });

  it('processes a document in the background, answers grounded questions with sources, and is plan-gated', async () => {
    const a = await signup('Rag');
    const up = await upload(a, 'requirements.md', REQS);
    expect(up.status).toBe(201);
    expect(up.body.data.storagePath).toBeUndefined();
    await drain();
    const doc = (await a.get(`/documents/${up.body.data.id}`)).body.data;
    expect(doc.status).toBe('READY');
    expect(doc.chunkCount).toBeGreaterThan(0);
    expect(doc.storagePath).toBeUndefined();

    // free plan: uploading works but RAG document-query is an upgrade feature
    const blocked = await a.post('/ai/document-query', { question: 'when do tokens expire?' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('UPGRADE_REQUIRED');

    await upgrade(a, 'pro');
    const r = (await a.post('/ai/document-query', { question: 'How long until authentication tokens expire?' })).body.data;
    expect(r.sources[0].name).toBe('requirements.md');
    expect(r.sources[0].snippet).toMatch(/fifteen minutes/);
    expect(r.answer).toMatch(/fifteen minutes/);

    const copilot = (await a.post('/ai/chat', { message: 'What does the spec say about invoice CSV export?' })).body.data;
    expect(copilot.sources.length).toBeGreaterThan(0);
    expect(copilot.answer).toMatch(/CSV|invoice/i);
    // conversations persist
    const convo = (await a.get(`/ai/conversations/${copilot.conversationId}`)).body.data;
    expect(convo.messages).toHaveLength(2);
  });

  it('never retrieves another workspace\'s chunks', async () => {
    const a = await signup('IsoA');
    const b = await signup('IsoB');
    await upgrade(a, 'pro');
    await upgrade(b, 'pro');
    await upload(a, 'a.txt', 'The launch codename is PROJECT-ZEPHYR and the vault password rotation happens quarterly.');
    await upload(b, 'b.txt', 'Our office plants are watered every Tuesday by the facilities team.');
    await drain();
    const fromB = (await b.post('/ai/document-query', { question: 'What is the launch codename PROJECT-ZEPHYR?' })).body.data;
    expect(JSON.stringify(fromB)).not.toMatch(/ZEPHYR/i);
    const fromA = (await a.post('/ai/document-query', { question: 'What is the launch codename?' })).body.data;
    expect(fromA.sources[0].name).toBe('a.txt');
    // cross-tenant document access
    const docs = (await a.get('/documents')).body.data;
    expect((await b.get(`/documents/${docs[0].id}`)).status).toBe(404);
    expect((await b.del(`/documents/${docs[0].id}`)).status).toBe(404);
  });

  it('marks unreadable files FAILED instead of hanging', async () => {
    const a = await signup('Fail');
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]); // looks like docx (zip magic) but is empty garbage
    const up = await upload(a, 'broken.docx', zip);
    expect(up.status).toBe(201);
    await drain();
    const d = (await a.get(`/documents/${up.body.data.id}`)).body.data;
    expect(d.status).toBe('FAILED');
    expect(d.error).toBeTruthy();
  });

  it('deleting a document removes it from search', async () => {
    const a = await signup('Del');
    await upgrade(a, 'pro');
    const up = await upload(a, 'gone.txt', 'The zebra crossing schedule is published every Monday morning.');
    await drain();
    expect((await a.post('/ai/document-query', { question: 'zebra crossing schedule' })).body.data.sources.length).toBe(1);
    expect((await a.del(`/documents/${up.body.data.id}`)).status).toBe(200);
    expect((await a.post('/ai/document-query', { question: 'zebra crossing schedule' })).body.data.sources.length).toBe(0);
  });
});

describe('AI task generation & meetings (human approval)', () => {
  it('returns candidates without writing tasks, then creates only approved ones', async () => {
    const a = await signup('Gen');
    const b = await addMemberSafe(a);
    const p = await makeProject(a);
    const gen = (await a.post('/ai/generate-tasks', { text: REQS })).body.data;
    expect(gen.candidates.length).toBeGreaterThanOrEqual(3);
    expect((await a.get('/tasks')).body.data).toHaveLength(0); // nothing persisted yet
    const pick = gen.candidates.slice(0, 2).map((c: any) => ({ title: c.title, description: c.description, priority: c.priority }));
    const created = await a.post('/tasks/bulk', { projectId: p.id, source: 'ai', tasks: pick });
    expect(created.status).toBe(201);
    expect((await a.get('/tasks')).body.data).toHaveLength(2);
    void b;
  });

  it('turns a transcript into summary, decisions, action items and tasks after approval', async () => {
    const a = await signup('Pat');
    await upgrade(a, 'pro');
    const bea = await addMember(a, 'member', 'Bea');
    const p = await makeProject(a);
    const transcript = `Pat: Thanks everyone for joining the launch sync.
Bea: We agreed to go with the staged rollout for the new billing page.
Pat: We decided the beta launches on 2030-03-15.
Bea: I'll write the migration guide by 2030-03-01.
Pat: Bea should update the pricing page copy ASAP.
Pat: Someone needs to schedule the customer webinar.`;
    const m = await a.post('/meetings', { title: 'Launch sync', transcript });
    expect(m.status).toBe(202);
    await drain();
    const meeting = (await a.get(`/meetings/${m.body.data.id}`)).body.data;
    expect(meeting.status).toBe('READY');
    expect(meeting.summary.length).toBeGreaterThan(10);
    expect(meeting.decisions.join(' ')).toMatch(/staged rollout/);
    expect(meeting.actionItems.length).toBeGreaterThanOrEqual(2);
    const guide = meeting.actionItems.find((i: any) => /migration guide/i.test(i.title));
    expect(guide.assigneeId).toBe(bea.id);
    expect(guide.dueDate).toContain('2030-03-01');

    const approve = await a.post(`/meetings/${meeting.id}/approve`, { projectId: p.id, items: [{ index: meeting.actionItems.indexOf(guide) }] });
    expect(approve.status).toBe(201);
    expect(approve.body.data.tasks[0].source).toBe('meeting');
    expect(approve.body.data.tasks[0].assigneeId).toBe(bea.id);
    // can't approve twice; only approved item became a task
    expect((await a.post(`/meetings/${meeting.id}/approve`, { projectId: p.id, items: [{ index: meeting.actionItems.indexOf(guide) }] })).status).toBe(409);
    expect((await a.get('/tasks')).body.data).toHaveLength(1);
  });

  it('gates the meeting assistant to paid plans', async () => {
    const a = await signup('Free');
    const r = await a.post('/meetings', { title: 't', transcript: 'x'.repeat(50) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('UPGRADE_REQUIRED');
  });
});

async function addMemberSafe(a: Actor) {
  return addMember(a, 'member');
}
