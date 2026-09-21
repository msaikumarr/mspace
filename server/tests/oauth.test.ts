import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setup, teardown, app, signup, addMember, type Actor } from './helpers';
import { createFakeProvider, CLIENT_ID, CLIENT_SECRET, type FakeProfile } from './support/fakeOAuthProvider';
import { configureOAuth } from '../src/services/auth/oauth';
import { User } from '../src/models/User';
import { Member, Workspace } from '../src/models/Workspace';
import { Invite } from '../src/models/Workspace';

const APP = 'http://app.test';
let fake: Awaited<ReturnType<typeof createFakeProvider>>;

beforeAll(async () => { await setup(); fake = await createFakeProvider(); });
afterAll(async () => { await fake.close(); await teardown(); });
beforeEach(() => {
  configureOAuth({
    redirectBase: APP, clientUrl: APP,
    providers: {
      google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, endpoints: fake.endpoints.google },
      github: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, endpoints: fake.endpoints.github },
    },
  });
  fake.setProfile(null);
  fake.state.tokenRequests.length = 0;
  fake.state.authorizeRequests.length = 0;
});
afterEach(() => configureOAuth());

let n = 0;
const person = (over: Partial<FakeProfile> = {}): FakeProfile => ({ sub: `sub-${Date.now()}-${++n}`, email: `person${Date.now()}-${n}@oauth.test`, name: 'Pat Person', emailVerified: true, ...over });
type Agent = ReturnType<typeof request.agent>;
const newAgent = () => request.agent(app);

/**
 * Runs a whole sign-in the way a browser would: /start -> provider authorize -> callback. Returns where the app finally
 * redirected the browser (the last hop's Location).
 */
async function signInVia(agent: Agent, provider: 'google' | 'github', p: FakeProfile, o: { returnTo?: string; link?: Actor } = {}) {
  fake.setProfile(p);
  let authorizeUrl: string;
  if (o.link) {
    const r = await agent.post(`/api/auth/oauth/${provider}/link`).set('Authorization', `Bearer ${o.link.token}`);
    expect(r.status).toBe(200);
    authorizeUrl = r.body.data.url;
  } else {
    const q = o.returnTo ? `?returnTo=${encodeURIComponent(o.returnTo)}` : '';
    const s = await agent.get(`/api/auth/oauth/${provider}/start${q}`).redirects(0);
    expect(s.status).toBe(302);
    authorizeUrl = s.headers.location;
  }
  const at = await fetch(authorizeUrl, { redirect: 'manual' }); // the provider
  expect(at.status).toBe(302);
  const cb = new URL(at.headers.get('location')!);
  const r = await agent.get(cb.pathname + cb.search).redirects(0); // back to the app
  return { status: r.status, location: r.headers.location as string, callbackPath: cb.pathname + cb.search, authorizeUrl };
}
const errorOf = (location: string) => new URL(location).searchParams.get('error');
const sessionOf = async (agent: Agent) => agent.post('/api/auth/refresh');
const userByEmail = (email: string) => User.findOne({ email }).select('+passwordHash');

describe('starting a sign-in', () => {
  it('lists only the configured providers', async () => {
    expect((await request(app).get('/api/auth/oauth/providers')).body.data.providers).toEqual([{ id: 'google', name: 'Google' }, { id: 'github', name: 'GitHub' }]);
    configureOAuth({
      redirectBase: APP, clientUrl: APP,
      providers: { google: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, endpoints: fake.endpoints.google }, github: { clientId: undefined, clientSecret: undefined } },
    });
    expect((await request(app).get('/api/auth/oauth/providers')).body.data.providers).toEqual([{ id: 'google', name: 'Google' }]);
  });

  it('redirects to the provider with PKCE, a state value and the exact callback URL, and sets a locked-down state cookie', async () => {
    const res = await request(app).get('/api/auth/oauth/google/start').redirects(0);
    expect(res.status).toBe(302);
    const u = new URL(res.headers.location);
    expect(u.origin + u.pathname).toBe(fake.endpoints.google.authorize);
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe(`${APP}/api/auth/oauth/google/callback`);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toContain('email');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('oauth_state='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/auth\/oauth/i);
    expect(u.toString()).not.toContain('client_secret'); // never sent through the browser
  });

  it('uses a fresh state and PKCE challenge every time', async () => {
    const a = new URL((await request(app).get('/api/auth/oauth/google/start').redirects(0)).headers.location);
    const b = new URL((await request(app).get('/api/auth/oauth/google/start').redirects(0)).headers.location);
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'));
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'));
  });

  it('sends the browser back to login when the provider is not configured or unknown', async () => {
    configureOAuth({ providers: { google: { clientId: undefined, clientSecret: undefined } }, redirectBase: APP, clientUrl: APP });
    expect(errorOf((await request(app).get('/api/auth/oauth/google/start').redirects(0)).headers.location)).toBe('oauth_unavailable');
    expect(errorOf((await request(app).get('/api/auth/oauth/myspace/start').redirects(0)).headers.location)).toBe('oauth_unavailable');
  });
});

describe('signing in', () => {
  it('creates an account, a workspace and a session for a first-time Google user, without ever exposing a token in a URL', async () => {
    const agent = newAgent();
    const p = person({ name: 'Grace Hopper' });
    const r = await signInVia(agent, 'google', p);
    expect(r.status).toBe(302);
    expect(r.location).toBe(`${APP}/app`);
    expect(r.location).not.toMatch(/token|access/i);

    const s = await sessionOf(agent);
    expect(s.status).toBe(200);
    expect(s.body.data.user).toMatchObject({ email: p.email, name: 'Grace Hopper' });
    expect(s.body.data.workspaces).toHaveLength(1);
    expect(s.body.data.workspaces[0].role).toBe('owner');

    const u = (await userByEmail(p.email))!;
    expect(u.emailVerified).toBe(true);
    expect(u.passwordHash).toBeUndefined();
    expect(u.identities).toMatchObject([{ provider: 'google', subject: p.sub, email: p.email }]);
  });

  it('proves the PKCE verifier and client secret to the provider on the token request', async () => {
    await signInVia(newAgent(), 'google', person());
    const t = fake.state.tokenRequests[0];
    expect(t).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: `${APP}/api/auth/oauth/google/callback` });
    expect(t.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the fake provider already verified sha256(verifier) === challenge, or the sign-in above would have failed
  });

  it('signs the same person into the same account next time, even if their provider email changed', async () => {
    const p = person();
    const first = await signInVia(newAgent(), 'google', p);
    expect(first.location).toBe(`${APP}/app`);
    const before = await User.countDocuments();
    const again = newAgent();
    const r = await signInVia(again, 'google', { ...p, email: `moved-${p.email}` });
    expect(r.location).toBe(`${APP}/app`);
    expect(await User.countDocuments()).toBe(before);
    expect((await sessionOf(again)).body.data.user.email).toBe(p.email);
  });

  it('works with GitHub, choosing the primary verified address', async () => {
    const p = person({
      sub: '424242',
      githubEmails: [
        { email: 'noise@x.test', primary: false, verified: false },
        { email: 'alt@x.test', primary: false, verified: true },
        { email: `primary-${Date.now()}@gh.test`, primary: true, verified: true },
      ],
    });
    const agent = newAgent();
    const r = await signInVia(agent, 'github', p);
    expect(r.location).toBe(`${APP}/app`);
    expect((await sessionOf(agent)).body.data.user.email).toBe(p.githubEmails![2].email);
  });

  it('honours an invitation that was waiting for this email', async () => {
    const owner = await signup('Inviter');
    const p = person();
    await Invite.create({ workspaceId: owner.workspaceId, email: p.email, role: 'manager', invitedBy: owner.id });
    const agent = newAgent();
    await signInVia(agent, 'google', p);
    const u = (await userByEmail(p.email))!;
    expect((await Member.findOne({ workspaceId: owner.workspaceId, userId: u._id }))!.role).toBe('manager');
    expect((await sessionOf(agent)).body.data.workspaces).toHaveLength(2); // the invited one plus their own
    expect(await Invite.countDocuments({ email: p.email })).toBe(0);
  });

  it('sends the person to a safe in-app page after sign-in, and never to another site', async () => {
    const ok = await signInVia(newAgent(), 'google', person(), { returnTo: '/app/projects?x=1' });
    expect(ok.location).toBe(`${APP}/app/projects?x=1`);
    for (const evil of ['https://evil.test', '//evil.test/app', '/\\evil.test', '/app//evil.test', 'javascript:alert(1)', '/elsewhere', '/app/\nx']) {
      const r = await signInVia(newAgent(), 'google', person(), { returnTo: evil });
      expect(r.location, `returnTo=${JSON.stringify(evil)}`).toBe(`${APP}/app`);
    }
  });
});

describe('protection against forged or replayed callbacks', () => {
  async function started(agent: Agent, provider: 'google' | 'github' = 'google') {
    fake.setProfile(person());
    const s = await agent.get(`/api/auth/oauth/${provider}/start`).redirects(0);
    const at = await fetch(s.headers.location, { redirect: 'manual' });
    const cb = new URL(at.headers.get('location')!);
    return { path: cb.pathname, code: cb.searchParams.get('code')!, state: cb.searchParams.get('state')! };
  }

  it('rejects a callback with no state cookie (login CSRF: an attacker\'s code delivered to a victim\'s browser)', async () => {
    const attacker = newAgent();
    const cb = await started(attacker);
    const victim = newAgent(); // never started a flow, so has no cookie
    const r = await victim.get(`${cb.path}?code=${cb.code}&state=${cb.state}`).redirects(0);
    expect(errorOf(r.headers.location)).toBe('oauth_state');
    expect((await sessionOf(victim)).status).toBe(401);
    expect(fake.state.tokenRequests).toHaveLength(0); // the code was never even redeemed
  });

  it('rejects a mismatched, missing or truncated state value', async () => {
    for (const bad of [`&state=${'0'.repeat(32)}`, '', '&state=abc']) {
      const agent = newAgent();
      const cb = await started(agent);
      const r = await agent.get(`${cb.path}?code=${cb.code}${bad}`).redirects(0);
      expect(errorOf(r.headers.location), `state suffix "${bad}"`).toBe('oauth_state');
    }
    expect(fake.state.tokenRequests).toHaveLength(0);
  });

  it('rejects a forged or expired state cookie, and one issued for a different provider', async () => {
    const agent = newAgent();
    const cb = await started(agent);
    const forged = jwt.sign({ typ: 'oauth_state', p: 'google', s: cb.state, v: 'x'.repeat(43), r: '/app' }, 'not-the-server-secret');
    let r = await request(app).get(`${cb.path}?code=${cb.code}&state=${cb.state}`).set('Cookie', `oauth_state=${forged}`).redirects(0);
    expect(errorOf(r.headers.location)).toBe('oauth_state');

    const expired = jwt.sign({ typ: 'oauth_state', p: 'google', s: cb.state, v: 'x'.repeat(43), r: '/app' }, 'e2e-secret-e2e-secret-123', { expiresIn: -10 });
    r = await request(app).get(`${cb.path}?code=${cb.code}&state=${cb.state}`).set('Cookie', `oauth_state=${expired}`).redirects(0);
    expect(errorOf(r.headers.location)).toBe('oauth_state');

    // A cookie issued for GitHub must not be accepted on Google's callback even when the state value itself matches.
    const gh = newAgent();
    const ghStart = await gh.get('/api/auth/oauth/github/start').redirects(0);
    const ghState = new URL(ghStart.headers.location).searchParams.get('state')!;
    r = await gh.get(`/api/auth/oauth/google/callback?code=anything&state=${ghState}`).redirects(0);
    expect(errorOf(r.headers.location)).toBe('oauth_state');
    expect(fake.state.tokenRequests).toHaveLength(0);
  });

  it('cannot be replayed: the state cookie is single-use and the provider code is one-time', async () => {
    const agent = newAgent();
    const cb = await started(agent);
    const first = await agent.get(`${cb.path}?code=${cb.code}&state=${cb.state}`).redirects(0);
    expect(first.headers.location).toBe(`${APP}/app`);
    const second = await agent.get(`${cb.path}?code=${cb.code}&state=${cb.state}`).redirects(0);
    expect(errorOf(second.headers.location)).toBe('oauth_state');
  });

  it('reports a denied consent screen without creating anything', async () => {
    const before = await User.countDocuments();
    fake.denyNext();
    const agent = newAgent();
    fake.setProfile(person());
    const s = await agent.get('/api/auth/oauth/google/start').redirects(0);
    const back = new URL((await fetch(s.headers.location, { redirect: 'manual' })).headers.get('location')!);
    expect(back.searchParams.get('error')).toBe('access_denied');
    const r = await agent.get(back.pathname + back.search).redirects(0);
    expect(errorOf(r.headers.location)).toBe('oauth_denied');
    expect(await User.countDocuments()).toBe(before);
  });

  it('fails cleanly when the provider\'s token endpoint errors', async () => {
    const before = await User.countDocuments();
    fake.failTokenNext();
    const r = await signInVia(newAgent(), 'google', person());
    expect(errorOf(r.location)).toBe('oauth_failed');
    expect(r.location).not.toMatch(/server_error|HTTP 5/); // provider detail stays in the log
    expect(await User.countDocuments()).toBe(before);
  });
});

describe('email trust and account linking', () => {
  it('refuses a provider email that is not verified, and creates nothing', async () => {
    const before = await User.countDocuments();
    const g = await signInVia(newAgent(), 'google', person({ emailVerified: false }));
    expect(errorOf(g.location)).toBe('oauth_email_unverified');
    const gh = await signInVia(newAgent(), 'github', person({ githubEmails: [{ email: 'x@y.test', primary: true, verified: false }] }));
    expect(errorOf(gh.location)).toBe('oauth_email_unverified');
    expect(await User.countDocuments()).toBe(before);
  });

  it('does not sign anyone into an existing password account whose email was never verified (pre-registration takeover)', async () => {
    const victimEmail = `victim-${Date.now()}@oauth.test`;
    const attacker = await signup('Attacker', victimEmail); // registers the victim's address with the attacker's password
    const agent = newAgent();
    const r = await signInVia(agent, 'google', person({ email: victimEmail }));
    expect(errorOf(r.location)).toBe('oauth_email_exists');
    expect((await sessionOf(agent)).status).toBe(401);
    expect((await userByEmail(victimEmail))!.identities).toHaveLength(0);
    expect(attacker.email).toBe(victimEmail);
  });

  it('lets that user connect the provider from Settings while signed in, then sign in with it', async () => {
    const email = `linker-${Date.now()}@oauth.test`;
    const me = await signup('Linker', email);
    const p = person({ email });
    const agent = newAgent();
    const linked = await signInVia(agent, 'google', p, { link: me });
    expect(linked.location).toBe(`${APP}/app/settings?linked=google`);

    const u = (await userByEmail(email))!;
    expect(u.identities).toMatchObject([{ provider: 'google', subject: p.sub }]);
    expect(u.emailVerified).toBe(true); // they just proved they control that inbox
    expect(u.passwordHash).toBeTruthy(); // and the password still works

    const later = newAgent();
    expect((await signInVia(later, 'google', p)).location).toBe(`${APP}/app`);
    expect((await sessionOf(later)).body.data.user.id).toBe(me.id);
  });

  it('connecting a provider under the account\'s own address verifies it and releases invitations that were waiting', async () => {
    const owner = await signup('Boss');
    const email = `waiting-${Date.now()}@oauth.test`;
    const me = await signup('Waiting', email);
    await Invite.create({ workspaceId: owner.workspaceId, email, role: 'member', invitedBy: owner.id });
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId: me.id })).toBeNull();

    await signInVia(newAgent(), 'google', person({ email }), { link: me });
    expect((await userByEmail(email))!.emailVerified).toBe(true);
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId: me.id })).toBeTruthy();
    expect(await Invite.countDocuments({ email })).toBe(0);
  });

  it('does not verify the account when the connected provider address is a different one', async () => {
    const me = await signup('Different', `own-${Date.now()}@oauth.test`);
    await signInVia(newAgent(), 'google', person({ email: `other-${Date.now()}@oauth.test` }), { link: me });
    expect((await User.findById(me.id))!.emailVerified).toBe(false);
  });

  it('links a second provider automatically when the account\'s email is already verified', async () => {
    const email = `both-${Date.now()}@oauth.test`;
    const g = person({ email, sub: 'g-1' });
    await signInVia(newAgent(), 'google', g);
    const agent = newAgent();
    const r = await signInVia(agent, 'github', person({ email, sub: '777' }));
    expect(r.location).toBe(`${APP}/app`);
    expect((await userByEmail(email))!.identities.map((i) => i.provider).sort()).toEqual(['github', 'google']);
    expect(await User.countDocuments({ email })).toBe(1);
  });

  it('treats a completed password reset as proof of the address, so a later Google sign-in links', async () => {
    const email = `reset-${Date.now()}@oauth.test`;
    await signup('Resetter', email);
    const f = await request(app).post('/api/auth/forgot-password').send({ email });
    expect((await request(app).post('/api/auth/reset-password').send({ token: f.body.data.devToken, password: 'a-new-password-1' })).status).toBe(200);
    const agent = newAgent();
    expect((await signInVia(agent, 'google', person({ email }))).location).toBe(`${APP}/app`);
    expect((await sessionOf(agent)).body.data.user.email).toBe(email);
  });

  it('will not attach a provider identity that already belongs to a different account', async () => {
    const shared = person();
    await signInVia(newAgent(), 'google', shared); // account A owns this Google identity
    const other = await signup('Other');
    const r = await signInVia(newAgent(), 'google', shared, { link: other });
    expect(r.location).toBe(`${APP}/app/settings?error=oauth_already_linked`);
    expect((await User.findById(other.id))!.identities).toHaveLength(0);
  });

  it('needs a signed-in user to start linking', async () => {
    expect((await request(app).post('/api/auth/oauth/google/link')).status).toBe(401);
    expect((await request(app).get('/api/auth/oauth/connections')).status).toBe(401);
    expect((await request(app).delete('/api/auth/oauth/google')).status).toBe(401);
  });

  it('reports link failures back to Settings, not the login page', async () => {
    const me = await signup('LinkFail');
    fake.denyNext();
    fake.setProfile(person());
    const agent = newAgent();
    const start = await agent.post('/api/auth/oauth/google/link').set('Authorization', `Bearer ${me.token}`);
    const back = new URL((await fetch(start.body.data.url, { redirect: 'manual' })).headers.get('location')!);
    const r = await agent.get(back.pathname + back.search).redirects(0);
    expect(r.headers.location).toBe(`${APP}/app/settings?error=oauth_denied`);
  });
});

describe('accounts with and without passwords', () => {
  it('a social-only account cannot log in or change a password it does not have, but can set one via reset', async () => {
    const p = person();
    await signInVia(newAgent(), 'google', p);
    const login = await request(app).post('/api/auth/login').send({ email: p.email, password: 'anything-at-all' });
    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe('INVALID_CREDENTIALS');

    const agent = newAgent();
    await signInVia(agent, 'google', p);
    const token = (await sessionOf(agent)).body.data.accessToken;
    const change = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'x', newPassword: 'whatever-123' });
    expect(change.status).toBe(400);
    expect(change.body.error.code).toBe('NO_PASSWORD');

    const f = await request(app).post('/api/auth/forgot-password').send({ email: p.email });
    await request(app).post('/api/auth/reset-password').send({ token: f.body.data.devToken, password: 'my-new-password-1' });
    expect((await request(app).post('/api/auth/login').send({ email: p.email, password: 'my-new-password-1' })).status).toBe(200);
  });

  it('lists connections and lets a user disconnect, but never their last way to sign in', async () => {
    const p = person();
    const agent = newAgent();
    await signInVia(agent, 'google', p);
    const token = (await sessionOf(agent)).body.data.accessToken as string;
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    const list = (await auth(request(app).get('/api/auth/oauth/connections'))).body.data;
    expect(list.hasPassword).toBe(false);
    expect(list.providers).toEqual([
      { id: 'google', name: 'Google', enabled: true, connected: true, email: p.email },
      { id: 'github', name: 'GitHub', enabled: true, connected: false },
    ]);

    const last = await auth(request(app).delete('/api/auth/oauth/google'));
    expect(last.status).toBe(400);
    expect(last.body.error.code).toBe('LAST_SIGN_IN_METHOD');

    // connect GitHub too, then Google can go
    await signInVia(agent, 'github', person({ email: p.email, sub: '31337' }), { link: { token } as Actor });
    expect((await auth(request(app).delete('/api/auth/oauth/google'))).status).toBe(200);
    expect((await auth(request(app).get('/api/auth/oauth/connections'))).body.data.providers.find((x: any) => x.id === 'google').connected).toBe(false);
    expect((await auth(request(app).delete('/api/auth/oauth/google'))).body.error.code).toBe('NOT_CONNECTED');
  });

  it('lets a user with a password disconnect their only provider', async () => {
    const email = `keepspw-${Date.now()}@oauth.test`;
    const me = await signup('HasPw', email);
    await signInVia(newAgent(), 'google', person({ email }), { link: me });
    expect((await request(app).delete('/api/auth/oauth/google').set('Authorization', `Bearer ${me.token}`)).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email, password: 'password123' })).status).toBe(200);
  });

  it('keeps registration from reusing an email that already has a social account', async () => {
    const p = person();
    await signInVia(newAgent(), 'google', p);
    const r = await request(app).post('/api/auth/register').send({ name: 'Squatter', email: p.email, password: 'password123' });
    expect(r.status).toBe(409);
  });

  it('gives social sign-ups a normal account: they can be invited to and act in workspaces', async () => {
    const owner = await signup('Boss');
    const p = person();
    const agent = newAgent();
    await signInVia(agent, 'google', p);
    const s = (await sessionOf(agent)).body.data;
    const joined = await request(app).post(`/api/workspaces/${owner.workspaceId}/invites`).set(owner.wsHeader()).send({ email: p.email, role: 'member' });
    expect(joined.body.data.status).toBe('added');
    expect(await Member.exists({ workspaceId: owner.workspaceId, userId: s.user.id })).toBeTruthy();
    expect((await Workspace.countDocuments({ ownerId: s.user.id }))).toBe(1);
    expect(addMember).toBeTypeOf('function');
  });
});
