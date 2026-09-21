import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { io as connect, Socket } from 'socket.io-client';
import { setup, teardown, app, signup, addMember, makeProject, upgrade } from './helpers';
import { initSockets, closeSockets } from '../src/sockets';

let server: http.Server;
let url: string;

beforeAll(async () => {
  await setup();
  server = http.createServer(app);
  initSockets(server);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await closeSockets();
  server.close();
  await teardown();
});

const open = (token: string) =>
  new Promise<Socket>((resolve, reject) => {
    const s = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const join = (s: Socket, ws: string) => new Promise<boolean>((r) => s.emit('workspace:join', ws, r));
const joinCh = (s: Socket, ch: string) => new Promise<boolean>((r) => s.emit('channel:join', ch, r));
const once = <T = any>(s: Socket, ev: string, ms = 3000) =>
  new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    s.once(ev, (d) => { clearTimeout(t); res(d); });
  });
const silent = (s: Socket, ev: string, ms = 600) =>
  new Promise<boolean>((res) => {
    let got = false;
    s.once(ev, () => (got = true));
    setTimeout(() => res(!got), ms);
  });

describe('realtime', () => {
  it('rejects unauthenticated sockets', async () => {
    await expect(open('garbage')).rejects.toBeTruthy();
  });

  it('broadcasts task events to authorised workspace members only, and tracks presence', async () => {
    const owner = await signup('RtOwner');
    const mate = await addMember(owner, 'member', 'Mate');
    const outsider = await signup('RtOutsider');
    const p = await makeProject(owner);

    const so = await open(owner.token);
    const sm = await open(mate.token);
    const sx = await open(outsider.token);
    expect(await join(so, owner.workspaceId)).toBe(true);
    expect(await join(sm, owner.workspaceId)).toBe(true);
    expect(await join(sx, owner.workspaceId)).toBe(false); // server verifies membership

    const gotMate = once(sm, 'task:created');
    const quietOutsider = silent(sx, 'task:created');
    const t = (await owner.post('/tasks', { projectId: p.id, title: 'live task' })).body.data;
    expect((await gotMate).title).toBe('live task');
    expect(await quietOutsider).toBe(true);

    const upd = once(sm, 'task:updated');
    await owner.patch(`/tasks/${t.id}`, { status: 'IN_PROGRESS' });
    expect((await upd).status).toBe('IN_PROGRESS');

    const online = await new Promise<string[]>((r) => so.emit('presence:list', owner.workspaceId, r));
    expect(online).toEqual(expect.arrayContaining([owner.id, mate.id]));
    const off = once(so, 'presence:update');
    sm.disconnect();
    expect(await off).toEqual({ userId: mate.id, online: false });
    so.disconnect();
    sx.disconnect();
  });

  it('delivers chat messages, typing indicators and per-user notifications in real time', async () => {
    const owner = await signup('ChatOwner');
    const mate = await addMember(owner, 'member', 'Chatty');
    const so = await open(owner.token);
    const sm = await open(mate.token);
    await join(so, owner.workspaceId);
    await join(sm, owner.workspaceId);
    const ch = (await owner.get('/channels')).body.data.find((c: any) => c.name === 'general');
    expect(await joinCh(so, ch.id)).toBe(true);
    expect(await joinCh(sm, ch.id)).toBe(true);

    const msgP = once(sm, 'message:new');
    const sent = await owner.post(`/channels/${ch.id}/messages`, { text: 'hello @Chatty', mentions: [mate.id] });
    expect(sent.status).toBe(201);
    const msg = await msgP;
    expect(msg.text).toBe('hello @Chatty');
    expect(msg.user.name).toBe('ChatOwner');

    const typing = once(sm, 'typing');
    so.emit('typing', { channelId: ch.id, typing: true });
    expect(await typing).toMatchObject({ userId: owner.id, typing: true });

    // mention notification arrives on the user's private room
    const notif = (await mate.get('/notifications')).body.data;
    expect(notif.items.some((n: any) => n.type === 'MENTION')).toBe(true);

    // unread + read receipts
    expect((await mate.get('/channels')).body.data.find((c: any) => c.id === ch.id).unread).toBe(1);
    await mate.post(`/channels/${ch.id}/read`);
    expect((await mate.get('/channels')).body.data.find((c: any) => c.id === ch.id).unread).toBe(0);

    // edit / react / delete permissions
    expect((await mate.patch(`/messages/${msg.id}`, { text: 'hijack' })).status).toBe(403);
    expect((await owner.patch(`/messages/${msg.id}`, { text: 'hello (edited)' })).body.data.editedAt).toBeTruthy();
    const r = await mate.post(`/messages/${msg.id}/reactions`, { emoji: '👍' });
    expect(r.body.data[0].emoji).toBe('👍');
    expect((await mate.post(`/messages/${msg.id}/reactions`, { emoji: '👍' })).body.data).toHaveLength(0); // toggle off
    so.disconnect();
    sm.disconnect();
  });

  it('keeps DMs private to their two participants', async () => {
    const a = await signup('DmA');
    await upgrade(a, 'pro');
    const b = await addMember(a, 'member', 'DmB');
    const c = await addMember(a, 'member', 'DmC');
    const dm = (await a.post('/channels/dm', { userId: b.id })).body.data;
    expect((await b.post('/channels/dm', { userId: a.id })).body.data.id).toBe(dm.id); // same channel both ways
    await a.post(`/channels/${dm.id}/messages`, { text: 'secret' });
    expect((await b.get(`/channels/${dm.id}/messages`)).body.data[0].text).toBe('secret');
    expect((await c.get(`/channels/${dm.id}/messages`)).status).toBe(404);
    expect((await c.post(`/channels/${dm.id}/messages`, { text: 'snoop' })).status).toBe(404);
    expect((await c.get('/channels')).body.data.some((x: any) => x.id === dm.id)).toBe(false);
    const sc = await open(c.token);
    await join(sc, a.workspaceId);
    expect(await joinCh(sc, dm.id)).toBe(false);
    sc.disconnect();
  });
});
