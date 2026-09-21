import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, signup, makeProject, upgrade, addMember } from './helpers';

beforeAll(setup);
afterAll(teardown);

const day = 24 * 3600 * 1000;

describe('tasks', () => {
  it('creates, filters, moves through the Kanban statuses and records activity', async () => {
    const a = await signup('Tasker');
    const p = await makeProject(a);
    const t = (await a.post('/tasks', { projectId: p.id, title: 'Write spec', priority: 'HIGH', labels: ['docs'] })).body.data;
    expect(t.status).toBe('TODO');
    expect(t.activity[0].action).toMatch(/created/);

    const moved = (await a.patch(`/tasks/${t.id}`, { status: 'DONE', position: 500 })).body.data;
    expect(moved.status).toBe('DONE');
    expect(moved.completedAt).toBeTruthy();
    expect(moved.activity.some((x: any) => /TODO → DONE/.test(x.action))).toBe(true);
    const back = (await a.patch(`/tasks/${t.id}`, { status: 'IN_PROGRESS' })).body.data;
    expect(back.completedAt).toBeFalsy();

    expect((await a.get(`/tasks?projectId=${p.id}&status=IN_PROGRESS`)).body.data).toHaveLength(1);
    expect((await a.get(`/tasks?projectId=${p.id}&status=TODO`)).body.data).toHaveLength(0);
    expect((await a.get(`/tasks?q=spec`)).body.data).toHaveLength(1);
    expect((await a.get(`/tasks?q=${encodeURIComponent('.*')}`)).body.data).toHaveLength(0); // regex chars are escaped
  });

  it('validates input and enforces assignee membership', async () => {
    const a = await signup('Val');
    const outsider = await signup('Outsider');
    const p = await makeProject(a);
    expect((await a.post('/tasks', { projectId: p.id, title: '' })).status).toBe(422);
    expect((await a.post('/tasks', { projectId: p.id, title: 'x', status: 'NOPE' })).status).toBe(422);
    expect((await a.post('/tasks', { projectId: 'not-an-id', title: 'x' })).status).toBeGreaterThanOrEqual(400);
    const r = await a.post('/tasks', { projectId: p.id, title: 'x', assigneeId: outsider.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_ASSIGNEE');
    expect((await a.get('/tasks/notanid')).status).toBe(400);
  });

  it('notifies assignees and mentions, never the actor', async () => {
    const owner = await signup('Boss');
    const dev = await addMember(owner, 'member', 'Dev');
    const p = await makeProject(owner);
    const t = (await owner.post('/tasks', { projectId: p.id, title: 'Ship it', assigneeId: dev.id })).body.data;
    const n = (await dev.get('/notifications')).body.data;
    expect(n.items.some((i: any) => i.type === 'TASK_ASSIGNED')).toBe(true);
    expect(n.unread).toBeGreaterThan(0);
    await owner.post(`/tasks/${t.id}/comments`, { text: 'ping @Dev', mentions: [dev.id] });
    const n2 = (await dev.get('/notifications')).body.data;
    expect(n2.items.some((i: any) => i.type === 'MENTION')).toBe(true);
    expect((await owner.get('/notifications')).body.data.items.some((i: any) => i.type === 'MENTION')).toBe(false);
    await dev.post('/notifications/read-all');
    expect((await dev.get('/notifications')).body.data.unread).toBe(0);
    const comments = (await dev.get(`/tasks/${t.id}/comments`)).body.data;
    expect(comments[0].user.name).toBe('Boss');
  });

  it('bulk-creates approved AI candidates and tags the source', async () => {
    const a = await signup('Bulk');
    const p = await makeProject(a);
    const r = await a.post('/tasks/bulk', { projectId: p.id, source: 'ai', tasks: [{ title: 'A', priority: 'HIGH' }, { title: 'B' }] });
    expect(r.status).toBe(201);
    expect(r.body.data.map((t: any) => t.source)).toEqual(['ai', 'ai']);
  });
});

describe('analytics & insights', () => {
  it('computes totals, completion rate, overdue, priority and workload', async () => {
    const a = await signup('Stats');
    await upgrade(a, 'pro');
    const p = await makeProject(a);
    const mk = (b: object) => a.post('/tasks', { projectId: p.id, ...b });
    await mk({ title: 'done1', status: 'DONE', assigneeId: a.id });
    await mk({ title: 'done2', status: 'DONE' });
    await mk({ title: 'late', dueDate: new Date(Date.now() - 3 * day).toISOString(), priority: 'URGENT', assigneeId: a.id });
    await mk({ title: 'open', priority: 'LOW' });

    const s = (await a.get('/analytics')).body.data;
    expect(s.locked).toBe(false);
    expect(s.totals).toMatchObject({ total: 4, completed: 2, pending: 2, overdue: 1, completionRate: 50 });
    expect(s.priority.find((x: any) => x.name === 'URGENT').value).toBe(1);
    expect(s.weekly.at(-1).completed).toBe(2);
    expect(s.workload[0]).toMatchObject({ name: 'Stats', open: 1, done: 1 });
    expect(s.projects[0]).toMatchObject({ total: 4, done: 2, progress: 50 });

    // cache is invalidated by writes
    await mk({ title: 'another' });
    expect((await a.get('/analytics')).body.data.totals.total).toBe(5);
    expect((await a.get(`/analytics?projectId=${p.id}`)).body.data.totals.total).toBe(5);

    const ins = (await a.post('/ai/insights')).body.data;
    expect(ins.items.some((i: any) => /overdue/i.test(i.title))).toBe(true);
    expect(ins.narrative).toBeTruthy();
  });

  it('locks advanced charts on the free plan but keeps the basics', async () => {
    const a = await signup('Freebie');
    const p = await makeProject(a);
    await a.post('/tasks', { projectId: p.id, title: 't' });
    const s = (await a.get('/analytics')).body.data;
    expect(s.locked).toBe(true);
    expect(s.totals.total).toBe(1);
    expect(s.weekly).toEqual([]);
  });
});
