import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setup, teardown, app, signup, addMember, makeProject, actorFrom, upgrade } from './helpers';

beforeAll(setup);
afterAll(teardown);

describe('tenant isolation', () => {
  it("blocks access to another workspace's data by header, by id, and by task id", async () => {
    const a = await signup('Alice');
    const b = await signup('Bob');
    const proj = await makeProject(a, 'Secret');
    const task = (await a.post('/tasks', { projectId: proj.id, title: 'Confidential' })).body.data;

    // Bob claims Alice's workspace
    expect((await b.get('/projects', a.workspaceId)).status).toBe(403);
    expect((await b.get('/projects', a.workspaceId)).body.error.code).toBe('NOT_A_MEMBER');
    // Bob uses his own workspace but Alice's ids
    expect((await b.get(`/projects/${proj.id}`)).status).toBe(404);
    expect((await b.get(`/tasks/${task.id}`)).status).toBe(404);
    expect((await b.patch(`/tasks/${task.id}`, { title: 'pwned' })).status).toBe(404);
    expect((await b.del(`/tasks/${task.id}`)).status).toBe(404);
    expect((await b.post('/tasks', { projectId: proj.id, title: 'inject' })).status).toBe(404);
    // Lists never leak
    expect((await b.get('/tasks')).body.data).toHaveLength(0);
    expect((await b.get('/workspaces/' + a.workspaceId)).status).toBe(403);
    // Alice's data is untouched
    expect((await a.get(`/tasks/${task.id}`)).body.data.title).toBe('Confidential');
  });

  it('requires a valid workspace header', async () => {
    const a = await signup('Nohdr');
    const r = await request(app).get('/api/projects').set('Authorization', `Bearer ${a.token}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('WORKSPACE_REQUIRED');
  });
});

describe('RBAC', () => {
  it('enforces the permission matrix from the spec', async () => {
    const owner = await signup('Owner');
    await upgrade(owner);
    const admin = await addMember(owner, 'admin');
    const manager = await addMember(owner, 'manager');
    const member = await addMember(owner, 'member');
    const viewer = await addMember(owner, 'viewer');

    // Create project: owner/admin/manager only
    for (const [who, expected] of [[owner, 201], [admin, 201], [manager, 201], [member, 403], [viewer, 403]] as const) {
      const r = await who.post('/projects', { name: `P-${who.email}` });
      expect(r.status, `create project as ${who.email}`).toBe(expected);
    }
    const proj = (await owner.get('/projects')).body.data[0];

    // Create/edit tasks: viewer no, member yes
    expect((await viewer.post('/tasks', { projectId: proj.id, title: 'x' })).status).toBe(403);
    const t = await member.post('/tasks', { projectId: proj.id, title: 'by member' });
    expect(t.status).toBe(201);
    expect((await viewer.patch(`/tasks/${t.body.data.id}`, { title: 'y' })).status).toBe(403);
    expect((await member.patch(`/tasks/${t.body.data.id}`, { title: 'edited' })).status).toBe(200);
    // Everyone can view
    expect((await viewer.get('/projects')).status).toBe(200);
    expect((await viewer.get('/tasks')).status).toBe(200);
    // Delete task: manager+
    expect((await member.del(`/tasks/${t.body.data.id}`)).status).toBe(403);
    expect((await manager.del(`/tasks/${t.body.data.id}`)).status).toBe(200);
    // Invites: manager+ only
    expect((await member.post(`/workspaces/${owner.workspaceId}/invites`, { email: 'z@test.dev', role: 'viewer' })).status).toBe(403);
    // Manage / delete workspace
    expect((await manager.patch(`/workspaces/${owner.workspaceId}`, { name: 'nope' })).status).toBe(403);
    expect((await admin.patch(`/workspaces/${owner.workspaceId}`, { name: 'Renamed' })).status).toBe(200);
    expect((await admin.del(`/workspaces/${owner.workspaceId}`)).status).toBe(403);
    // Viewer can't chat-write or use AI
    const ch = (await owner.get('/channels')).body.data[0];
    expect((await viewer.post(`/channels/${ch.id}/messages`, { text: 'hi' })).status).toBe(403);
    expect((await viewer.post('/ai/chat', { message: 'hi' })).status).toBe(403);
    expect((await member.post('/ai/chat', { message: 'hi' })).status).toBe(200);
  });

  it('prevents privilege escalation through role changes', async () => {
    const owner = await signup('Own2');
    await upgrade(owner);
    const admin = await addMember(owner, 'admin');
    const manager = await addMember(owner, 'manager');
    // manager has no member:manage
    expect((await manager.patch(`/workspaces/${owner.workspaceId}/members/${manager.id}`, { role: 'admin' })).status).toBe(403);
    // admin cannot promote to admin or touch the owner
    expect((await admin.patch(`/workspaces/${owner.workspaceId}/members/${manager.id}`, { role: 'admin' })).status).toBe(403);
    expect((await admin.patch(`/workspaces/${owner.workspaceId}/members/${owner.id}`, { role: 'viewer' })).status).toBe(403);
    expect((await admin.patch(`/workspaces/${owner.workspaceId}/members/${manager.id}`, { role: 'owner' })).status).toBe(403);
    // admin can demote manager to viewer
    expect((await admin.patch(`/workspaces/${owner.workspaceId}/members/${manager.id}`, { role: 'viewer' })).status).toBe(200);
    // owner can promote to admin; owner can't be removed
    expect((await owner.patch(`/workspaces/${owner.workspaceId}/members/${manager.id}`, { role: 'admin' })).status).toBe(200);
    expect((await admin.del(`/workspaces/${owner.workspaceId}/members/${owner.id}`)).status).toBe(403);
    // invite can't grant owner
    expect((await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email: 'q@test.dev', role: 'owner' })).status).toBe(400);
  });

  it('honours pending invitations at registration and allows leaving', async () => {
    const owner = await signup('Own3');
    const inv = await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email: 'newbie@test.dev', role: 'manager' });
    expect(inv.body.data.status).toBe('pending');
    const reg = await request(app).post('/api/auth/register').send({ name: 'Newbie', email: 'newbie@test.dev', password: 'password123' });
    const ws = reg.body.data.workspaces.find((w: any) => w.id === owner.workspaceId);
    expect(ws.role).toBe('manager');
    const newbie = actorFrom(reg.body.data.accessToken, reg.body.data.user.id, 'newbie@test.dev', owner.workspaceId);
    expect((await newbie.del(`/workspaces/${owner.workspaceId}/members/${newbie.id}`)).status).toBe(200);
    expect((await newbie.get('/projects')).status).toBe(403);
    // duplicate invite of an existing member is a conflict
    expect((await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email: owner.email, role: 'viewer' })).status).toBe(409);
  });

  it('deleting a workspace requires typed confirmation and removes its data', async () => {
    const o = await signup('Del');
    const p = await makeProject(o);
    expect((await o.del(`/workspaces/${o.workspaceId}`)).status).toBe(422);
    const r = await request(app).delete(`/api/workspaces/${o.workspaceId}`).set(o.wsHeader()).send({ confirmName: 'Wrong' });
    expect(r.status).toBe(400);
    const ok = await request(app).delete(`/api/workspaces/${o.workspaceId}`).set(o.wsHeader()).send({ confirmName: 'Del WS' });
    expect(ok.status).toBe(200);
    expect((await o.get(`/projects/${p.id}`)).status).toBe(403);
  });
});
