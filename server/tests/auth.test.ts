import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setup, teardown, app, signup } from './helpers';

beforeAll(setup);
afterAll(teardown);

describe('auth', () => {
  it('registers, creates a workspace, and never returns the password hash', async () => {
    const r = await request(app).post('/api/auth/register').send({ name: 'Ada Lovelace', email: 'ada@test.dev', password: 'password123' });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.data.workspaces[0].role).toBe('owner');
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|password123/);
    expect(r.headers['set-cookie'][0]).toMatch(/refresh_token=.*HttpOnly/i);
  });

  it('rejects duplicates, weak passwords and bad emails with the standard error shape', async () => {
    const dup = await request(app).post('/api/auth/register').send({ name: 'X', email: 'ADA@test.dev', password: 'password123' });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ success: false, error: { code: 'EMAIL_TAKEN', message: expect.any(String) } });
    const weak = await request(app).post('/api/auth/register').send({ name: 'X', email: 'x@test.dev', password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    expect((await request(app).post('/api/auth/register').send({ name: 'X', email: 'nope', password: 'password123' })).status).toBe(422);
  });

  it('logs in, rejects wrong credentials identically for unknown and known users', async () => {
    const ok = await request(app).post('/api/auth/login').send({ email: 'ada@test.dev', password: 'password123' });
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/api/auth/login').send({ email: 'ada@test.dev', password: 'wrong-password' });
    const ghost = await request(app).post('/api/auth/login').send({ email: 'ghost@test.dev', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(bad.body.error.message).toBe(ghost.body.error.message);
  });

  it('protects /me and accepts a valid bearer token', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', 'Bearer junk')).status).toBe(401);
    const a = await signup('Me');
    const me = await a.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(a.email);
  });

  it('refreshes from the cookie and rejects an access token used as a refresh token', async () => {
    const agent = request.agent(app);
    const reg = await agent.post('/api/auth/register').send({ name: 'Ref', email: 'ref@test.dev', password: 'password123' });
    const r = await agent.post('/api/auth/refresh');
    expect(r.status).toBe(200);
    expect(r.body.data.accessToken).toBeTruthy();
    const fake = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${reg.body.data.accessToken}`);
    expect(fake.status).toBe(401);
  });

  it('logout-all invalidates existing access tokens', async () => {
    const a = await signup('Out');
    expect((await a.post('/auth/logout-all')).status).toBe(200);
    expect((await a.get('/auth/me')).status).toBe(401);
  });

  it('runs the forgot/reset flow, single-use, and signs out other sessions', async () => {
    const a = await signup('Rst', 'reset@test.dev');
    const f = await request(app).post('/api/auth/forgot-password').send({ email: 'reset@test.dev' });
    const token = f.body.data.devToken;
    expect(token).toBeTruthy();
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@test.dev' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.data.message).toBe(f.body.data.message); // no account enumeration
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'brand-new-pass' })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'another-pass-1' })).status).toBe(400);
    expect((await a.get('/auth/me')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'reset@test.dev', password: 'brand-new-pass' })).status).toBe(200);
  });

  it('returns a JSON 404 for unknown routes and 400 for malformed JSON', async () => {
    const r = await request(app).get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('ROUTE_NOT_FOUND');
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_JSON');
  });
});
