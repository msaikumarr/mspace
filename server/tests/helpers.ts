import request from 'supertest';
import type { Express } from 'express';
import { connectDb, disconnectDb } from '../src/config/db';
import { createApp } from '../src/app';
import mongoose from 'mongoose';

export let app: Express;
let n = 0;

export async function setup() {
  await connectDb();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.syncIndexes();
  app = createApp();
}
export const teardown = () => disconnectDb();

export interface Actor {
  id: string;
  email: string;
  token: string;
  workspaceId: string;
  wsHeader: (ws?: string) => Record<string, string>;
  get: (url: string, ws?: string) => request.Test;
  post: (url: string, body?: object, ws?: string) => request.Test;
  patch: (url: string, body?: object, ws?: string) => request.Test;
  del: (url: string, ws?: string) => request.Test;
}

export const actorFrom = (token: string, id: string, email: string, workspaceId: string): Actor => {
  const h = (ws?: string) => ({ Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws || workspaceId });
  return {
    id, email, token, workspaceId, wsHeader: h,
    get: (url, ws) => request(app).get(`/api${url}`).set(h(ws)),
    post: (url, body = {}, ws) => request(app).post(`/api${url}`).set(h(ws)).send(body),
    patch: (url, body = {}, ws) => request(app).patch(`/api${url}`).set(h(ws)).send(body),
    del: (url, ws) => request(app).delete(`/api${url}`).set(h(ws)),
  };
};

export async function signup(name = 'User', email?: string): Promise<Actor> {
  n++;
  email = email || `user${n}-${Date.now()}@test.dev`;
  const r = await request(app).post('/api/auth/register').send({ name, email, password: 'password123', workspaceName: `${name} WS` });
  if (r.status !== 201) throw new Error(`signup failed: ${JSON.stringify(r.body)}`);
  return actorFrom(r.body.data.accessToken, r.body.data.user.id, email, r.body.data.workspaces[0].id);
}

/** Adds an existing user to `owner`'s workspace with the given role and returns them as an actor bound to that workspace. */
export async function addMember(owner: Actor, role: string, name = role): Promise<Actor> {
  const u = await signup(name);
  const r = await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email: u.email, role });
  if (r.status !== 201) throw new Error(`invite failed: ${JSON.stringify(r.body)}`);
  return actorFrom(u.token, u.id, u.email, owner.workspaceId);
}

export async function makeProject(a: Actor, name = 'Proj') {
  const r = await a.post('/projects', { name });
  if (r.status !== 201) throw new Error(`project failed: ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string };
}

export async function upgrade(owner: Actor, plan: 'pro' | 'business' = 'business') {
  const r = await owner.post('/billing/change-plan', { plan });
  if (r.status !== 200) throw new Error(`upgrade failed: ${JSON.stringify(r.body)}`);
}
