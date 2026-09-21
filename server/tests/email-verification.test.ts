import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import { setup, teardown, app, signup, type Actor } from './helpers';
import { createSmtpCapture, type Captured } from './support/smtpCapture';
import { configureMail } from '../src/config/mail';
import { closeMailTransport } from '../src/services/notifications/email';
import { RESEND_COOLDOWN_MS } from '../src/services/auth/authService';
import { User } from '../src/models/User';
import { Invite, Member } from '../src/models/Workspace';
import { Notification } from '../src/models/Misc';

let smtp: Awaited<ReturnType<typeof createSmtpCapture>>;
const APP = 'http://app.test';

beforeAll(async () => { await setup(); smtp = await createSmtpCapture(); });
afterAll(async () => { await smtp.close(); await teardown(); });
beforeEach(() => configureMail({ smtpUrl: smtp.url, from: 'M-Space <no-reply@mspace.test>', require: 'true', appUrl: APP }));
afterEach(() => { configureMail(); closeMailTransport(); smtp.clear(); });

let n = 0;
const address = (tag = 'u') => `${tag}${Date.now()}-${++n}@ev.test`;
const register = (email: string, name = 'Vera Fied', extra: object = {}) => request(app).post('/api/auth/register').send({ name, email, password: 'password123', ...extra });
const tokenIn = (m: Captured) => new URL(m.links.find((l) => l.includes('/verify-email'))!).searchParams.get('token')!;
const verify = (token: string) => request(app).post('/api/auth/verify-email').send({ token });
const me = async (token: string) => (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).body.data.user;
const dbUser = (email: string) => User.findOne({ email }).select('+verifyTokenHash +verifyTokenExpires +verifySentAt');

/** Registers an account and completes verification through the emailed link, like a person would. */
async function verifiedAccount(tag = 'v') {
  const email = address(tag);
  const r = await register(email);
  expect((await verify(tokenIn(await smtp.latest(email)))).status).toBe(200);
  return { email, id: r.body.data.user.id as string, token: r.body.data.accessToken as string, workspaceId: r.body.data.workspaces[0].id as string };
}

describe('signing up', () => {
  it('emails a confirmation link, flags the account as unverified, and never stores the token itself', async () => {
    const email = address();
    const r = await register(email, 'Vera Fied');
    expect(r.status).toBe(201);
    expect(r.body.data.user).toMatchObject({ emailVerified: false, needsEmailVerification: true });

    const mail = await smtp.latest(email);
    expect(mail.subject).toMatch(/Confirm your email/);
    expect(mail.text).toContain('Hi Vera,');
    const token = tokenIn(mail);
    expect(mail.links).toContain(`${APP}/verify-email?token=${token}`);
    expect(mail.html).toContain(`${APP}/verify-email?token=${token}`);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.data.devVerifyToken).toBe(token); // echoed outside production only, like the password-reset token

    const stored = (await dbUser(email))!;
    expect(stored.verifyTokenHash).toBeTruthy();
    expect(stored.verifyTokenHash).not.toBe(token); // only a hash is kept
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.verifyTokenExpires!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(JSON.stringify((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${r.body.data.accessToken}`)).body)).not.toMatch(/verifyToken/);
  });

  it('still succeeds when the mail server is down, and the person can ask for the email again', async () => {
    configureMail({ smtpUrl: 'smtp://127.0.0.1:1' });
    const email = address();
    const r = await register(email);
    expect(r.status).toBe(201);
    expect(r.body.data.user.needsEmailVerification).toBe(true);
    configureMail({ smtpUrl: smtp.url });
    expect((await request(app).post('/api/auth/resend-verification').set('Authorization', `Bearer ${r.body.data.accessToken}`)).status).toBe(200);
    expect((await smtp.latest(email)).subject).toMatch(/Confirm/);
  });

  it('sends nothing and asks for nothing when this server has no way to send email', async () => {
    configureMail({ smtpUrl: undefined, require: 'auto' });
    const r = await register(address());
    expect(r.status).toBe(201);
    expect(r.body.data.user.needsEmailVerification).toBe(false);
    expect(r.body.data.devVerifyToken).toBeUndefined();
    expect(smtp.messages).toHaveLength(0);
    const resend = await request(app).post('/api/auth/resend-verification').set('Authorization', `Bearer ${r.body.data.accessToken}`);
    expect(resend.status).toBe(400);
    expect(resend.body.error.code).toBe('VERIFICATION_NOT_REQUIRED');
  });

  it('"auto" turns verification on exactly when SMTP is configured', async () => {
    configureMail({ smtpUrl: smtp.url, require: 'auto' });
    expect((await register(address())).body.data.user.needsEmailVerification).toBe(true);
    configureMail({ smtpUrl: smtp.url, require: 'false' });
    expect((await register(address())).body.data.user.needsEmailVerification).toBe(false);
  });
});

describe('confirming the address', () => {
  it('verifies the account from the emailed link, even from a browser that is not signed in', async () => {
    const email = address();
    const r = await register(email);
    const token = tokenIn(await smtp.latest(email));
    const res = await verify(token); // no cookies, no Authorization: a link opened elsewhere
    expect(res.status).toBe(200);
    expect(res.body.data.verified).toBe(true);
    expect(await me(r.body.data.accessToken)).toMatchObject({ emailVerified: true, needsEmailVerification: false });
    const stored = (await dbUser(email))!;
    expect(stored.emailVerified).toBe(true);
    expect(stored.verifyTokenHash).toBeUndefined();
  });

  it('accepts a link once, and rejects unknown, expired and tampered ones', async () => {
    const email = address();
    await register(email);
    const token = tokenIn(await smtp.latest(email));

    for (const bad of ['0'.repeat(64), token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), 'short']) {
      const r = await verify(bad);
      expect(r.status, bad).toBe(bad === 'short' ? 422 : 400);
    }
    await User.updateOne({ email }, { verifyTokenExpires: new Date(Date.now() - 1000) });
    const expired = await verify(token);
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('VERIFY_TOKEN_INVALID');
    expect((await dbUser(email))!.emailVerified).toBe(false);

    await User.updateOne({ email }, { verifyTokenExpires: new Date(Date.now() + 3600_000) });
    expect((await verify(token)).status).toBe(200);
    const again = await verify(token);
    expect(again.status).toBe(400); // single use
    expect(again.body.error.code).toBe('VERIFY_TOKEN_INVALID');
  });

  it('a link cannot verify a different account', async () => {
    const a = address('a'), b = address('b');
    await register(a);
    await register(b);
    await verify(tokenIn(await smtp.latest(a)));
    expect((await dbUser(a))!.emailVerified).toBe(true);
    expect((await dbUser(b))!.emailVerified).toBe(false);
  });
});

describe('asking for another email', () => {
  it('needs a signed-in user', async () => {
    expect((await request(app).post('/api/auth/resend-verification')).status).toBe(401);
  });

  it('sends a new link that replaces the old one, but not more than once a minute', async () => {
    const email = address();
    const r = await register(email);
    const auth = { Authorization: `Bearer ${r.body.data.accessToken}` };
    const first = tokenIn(await smtp.latest(email));

    const tooSoon = await request(app).post('/api/auth/resend-verification').set(auth);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('RESEND_TOO_SOON');
    expect(tooSoon.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(smtp.to(email)).toHaveLength(1);

    await User.updateOne({ email }, { verifySentAt: new Date(Date.now() - RESEND_COOLDOWN_MS - 1000) });
    const ok = await request(app).post('/api/auth/resend-verification').set(auth);
    expect(ok.status).toBe(200);
    expect(smtp.to(email)).toHaveLength(2);
    const second = tokenIn(smtp.to(email)[1]);
    expect(second).not.toBe(first);

    expect((await verify(first)).status).toBe(400); // the earlier link no longer works
    expect((await verify(second)).status).toBe(200);
  });

  it('tells someone who is already verified, without sending anything', async () => {
    const v = await verifiedAccount();
    smtp.clear();
    const r = await request(app).post('/api/auth/resend-verification').set('Authorization', `Bearer ${v.token}`);
    expect(r.body.data).toEqual({ alreadyVerified: true });
    expect(smtp.messages).toHaveLength(0);
  });
});

describe('what an unverified address must not be able to claim', () => {
  it('does not accept invitations that were waiting for the address until it is verified', async () => {
    const owner = await signup('Boss');
    const email = address('invitee');
    expect((await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email, role: 'manager' })).body.data.status).toBe('pending');
    const r = await register(email);
    const userId = r.body.data.user.id;

    // registering with the address is not proof of owning it
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId })).toBeNull();
    expect(await Invite.countDocuments({ workspaceId: owner.workspaceId, email })).toBe(1);
    expect(r.body.data.workspaces).toHaveLength(1); // only their own

    await verify(tokenIn(await smtp.latest(email)));
    const joined = await Member.findOne({ workspaceId: owner.workspaceId, userId });
    expect(joined?.role).toBe('manager');
    expect(await Invite.countDocuments({ email })).toBe(0);
    expect(await Notification.exists({ userId, type: 'INVITATION' })).toBeTruthy();
    expect((await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${r.headers['set-cookie']?.[0].match(/refresh_token=([^;]+)/)?.[1]}`)).body.data.workspaces).toHaveLength(2);
  });

  it('keeps an invitation pending, instead of adding, when the invited account has an unverified address', async () => {
    const owner = await signup('Boss');
    const email = address('squatted');
    const squatter = await register(email); // someone registered this address without proving they own it
    smtp.clear();

    const r = await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email, role: 'member' });
    expect(r.body.data.status).toBe('pending');
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId: squatter.body.data.user.id })).toBeNull();

    const notice = await smtp.latest(email);
    expect(notice.subject).toMatch(/invited you to/);
    expect(notice.text).toContain('as member');

    // the real owner of the address proves it, and only then does the invitation apply
    await verify(squatter.body.data.devVerifyToken);
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId: squatter.body.data.user.id })).toBeTruthy();
  });

  it('adds an account straight away once its address is verified', async () => {
    const owner = await signup('Boss');
    const v = await verifiedAccount('vmate');
    const r = await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email: v.email, role: 'member' });
    expect(r.body.data.status).toBe('added');
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId: v.id })).toBeTruthy();
  });

  it('emails an invitation to someone with no account yet, naming who invited them', async () => {
    const owner = await signup('Grace Boss');
    const email = address('newcomer');
    await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email, role: 'viewer' });
    const m = await smtp.latest(email);
    expect(m.subject).toContain('Grace Boss invited you to Grace Boss WS');
    expect(m.text).toContain('as viewer');
    expect(m.links).toContain(`${APP}/login`);
  });

  it('withholds platform-admin status from an ADMIN_EMAILS address until it is verified', async () => {
    const email = 'root@admin.test';
    const r = await register(email, 'Root');
    const token = r.body.data.accessToken as string;
    expect(r.body.data.user.isPlatformAdmin).toBe(false);
    expect((await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token}`)).status).toBe(403);

    await verify(tokenIn(await smtp.latest(email)));
    expect((await me(token)).isPlatformAdmin).toBe(true);
    expect((await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('keeps the older trusting behaviour where verification is off: invitations join at once, admin is granted', async () => {
    configureMail({ smtpUrl: undefined, require: 'auto' });
    const owner = await signup('Boss');
    const email = 'root2@admin.test';
    await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email, role: 'member' });
    const r = await register(email, 'Root Two');
    expect(r.body.data.user.isPlatformAdmin).toBe(true);
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId: r.body.data.user.id })).toBeTruthy();
  });
});

describe('password reset now really sends email', () => {
  it('emails the reset link, answers identically for an unknown address, and does not email strangers', async () => {
    const v = await verifiedAccount('reset');
    smtp.clear();
    const known = await request(app).post('/api/auth/forgot-password').send({ email: v.email });
    const unknownEmail = address('nobody');
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: unknownEmail });
    expect(known.status).toBe(200);
    expect(known.body.data.message).toBe(unknown.body.data.message); // no account enumeration

    const mail = await smtp.latest(v.email);
    expect(mail.subject).toMatch(/Reset your/);
    const link = mail.links.find((l) => l.includes('/reset-password'))!;
    expect(link.startsWith(`${APP}/reset-password?token=`)).toBe(true);
    expect(new URL(link).searchParams.get('token')).toBe(known.body.data.devToken);
    expect(smtp.to(unknownEmail)).toHaveLength(0);
  });

  it('proves ownership of the address: it verifies the account and releases waiting invitations', async () => {
    const owner = await signup('Boss');
    const email = address('forgot');
    const r = await register(email); // unverified
    await owner.post(`/workspaces/${owner.workspaceId}/invites`, { email, role: 'member' }); // pending, since unverified
    const userId = r.body.data.user.id;
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId })).toBeNull();

    await request(app).post('/api/auth/forgot-password').send({ email });
    const link = (await smtp.latest(email)).links.find((l) => l.includes('/reset-password'))!;
    const reset = await request(app).post('/api/auth/reset-password').send({ token: new URL(link).searchParams.get('token'), password: 'a-new-password-9' });
    expect(reset.status).toBe(200);

    expect((await dbUser(email))!.emailVerified).toBe(true);
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId })).toBeTruthy();
    expect((await request(app).post('/api/auth/login').send({ email, password: 'a-new-password-9' })).status).toBe(200);
  });
});

describe('the API contract for signed-in users', () => {
  it('reports the verification state in the session and in /auth/me', async () => {
    const email = address();
    const r = await register(email);
    expect((await me(r.body.data.accessToken)).needsEmailVerification).toBe(true);
    const login = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
    expect(login.body.data.user).toMatchObject({ emailVerified: false, needsEmailVerification: true });
    await verify(tokenIn(await smtp.latest(email)));
    const after = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
    expect(after.body.data.user).toMatchObject({ emailVerified: true, needsEmailVerification: false });
  });

  it('does not lock unverified people out of the rest of the app', async () => {
    const r = await register(address());
    const a = { Authorization: `Bearer ${r.body.data.accessToken}`, 'X-Workspace-Id': r.body.data.workspaces[0].id };
    expect((await request(app).post('/api/projects').set(a).send({ name: 'Mine' })).status).toBe(201);
    expect((await request(app).get('/api/tasks').set(a)).status).toBe(200);
  });
});

// keep `Actor` referenced so the import is used when helpers change
export type _Unused = Actor;
