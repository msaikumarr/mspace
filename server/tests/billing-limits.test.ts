import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, teardown, signup, makeProject, addMember, upgrade } from './helpers';
import { PLANS } from '../src/config/plans';

beforeAll(setup);
afterAll(teardown);

describe('plans, usage and limits', () => {
  it('enforces the project limit with a 429 and a product-specific code, and lifts it on upgrade', async () => {
    const a = await signup('Lim');
    for (let i = 0; i < PLANS.free.maxProjects; i++) await makeProject(a, `P${i}`);
    const r = await a.post('/projects', { name: 'one too many' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('PROJECT_LIMIT_EXCEEDED');
    await upgrade(a, 'pro');
    expect((await a.post('/projects', { name: 'now ok' })).status).toBe(201);
  });

  it('enforces the member limit', async () => {
    const a = await signup('Team');
    for (let i = 0; i < PLANS.free.maxMembers - 1; i++) await addMember(a, 'member', `m${i}`);
    const extra = await signup('Extra');
    const r = await a.post(`/workspaces/${a.workspaceId}/invites`, { email: extra.email, role: 'member' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('MEMBER_LIMIT_EXCEEDED');
  });

  it('meters AI usage per workspace, returns 429 when exhausted, and refunds failed calls', async () => {
    const a = await signup('Meter');
    const budget = PLANS.free.aiRequestsPerMonth;
    // a failing call (validation error) must not consume credit
    expect((await a.post('/ai/chat', { message: '' })).status).toBe(422);
    expect((await a.get('/billing')).body.data.usage.aiRequests.used).toBe(0);
    for (let i = 0; i < budget; i++) expect((await a.post('/ai/chat', { message: `hello ${i}` })).status).toBe(200);
    expect((await a.get('/billing')).body.data.usage.aiRequests.used).toBe(budget);
    const over = await a.post('/ai/chat', { message: 'one more' });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('AI_LIMIT_EXCEEDED');
    // other workspaces are unaffected
    const b = await signup('Other');
    expect((await b.post('/ai/chat', { message: 'hi' })).status).toBe(200);
    // upgrading raises the ceiling
    await upgrade(a, 'pro');
    expect((await a.post('/ai/chat', { message: 'after upgrade' })).status).toBe(200);
  });

  it('gates audit logs to Business, records key actions, and restricts the endpoint to admins', async () => {
    const o = await signup('Audit');
    expect((await o.get('/audit-logs')).body.error.code).toBe('UPGRADE_REQUIRED');
    await upgrade(o, 'business');
    const p = await makeProject(o, 'Audited');
    const t = (await o.post('/tasks', { projectId: p.id, title: 'gone' })).body.data;
    await o.del(`/tasks/${t.id}`);
    const member = await addMember(o, 'member');
    const logs = (await o.get('/audit-logs')).body.data;
    const actions = logs.map((l: any) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['PROJECT_CREATED', 'TASK_CREATED', 'TASK_DELETED', 'USER_INVITED', 'SUBSCRIPTION_CHANGED']));
    expect(logs[0].actor.name).toBe('Audit');
    expect((await member.get('/audit-logs')).status).toBe(403);
  });

  it('blocks downgrades that would exceed the lower plan', async () => {
    const o = await signup('Down');
    await upgrade(o, 'pro');
    for (let i = 0; i < PLANS.free.maxProjects + 1; i++) await makeProject(o, `D${i}`);
    const r = await o.post('/billing/change-plan', { plan: 'free' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('DOWNGRADE_BLOCKED');
  });

  it('restricts billing changes to owner/admin and platform stats to platform admins', async () => {
    const o = await signup('Bill');
    await upgrade(o, 'pro');
    const m = await addMember(o, 'member');
    expect((await m.post('/billing/change-plan', { plan: 'business' })).status).toBe(403);
    expect((await m.get('/billing')).status).toBe(200);
    expect((await o.get('/admin/stats')).status).toBe(403);
  });
});
