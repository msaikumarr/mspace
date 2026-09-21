import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

/**
 * A stand-in for Google and GitHub that speaks the same protocol (authorization code + PKCE), so sign-in can be tested
 * end to end without the real services. It enforces what a real provider does: one-time codes, redirect_uri and client
 * credentials must match, and the PKCE verifier must hash to the challenge. Requests it would reject with 400 are
 * rejected here too, so a bug in the app's requests fails the test instead of passing silently.
 *
 * Two ways to approve a sign-in: tests call setProfile() and the authorize step redirects straight back; without a
 * profile it serves a small HTML form (used by the browser tests, and by `npx tsx` when run directly).
 */
export const CLIENT_ID = 'fake-client';
export const CLIENT_SECRET = 'fake-secret';

export interface FakeProfile {
  /** Stable provider-side id (Google `sub`, GitHub numeric `id`). */
  sub: string;
  email: string;
  emailVerified?: boolean;
  name?: string;
  /** GitHub only: overrides the /user/emails list. */
  githubEmails?: { email: string; primary: boolean; verified: boolean }[];
}

interface Grant { challenge: string; redirectUri: string; clientId: string; profile: FakeProfile; used: boolean }

const sha256url = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => resolve(b));
});
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function createFakeProvider(port = 0) {
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, FakeProfile>();
  let profile: FakeProfile | null = null;
  const state = { denyNext: false, failTokenNext: false, tokenRequests: [] as Record<string, string>[], authorizeRequests: [] as Record<string, string>[] };

  const issueCode = (q: URLSearchParams, p: FakeProfile) => {
    const code = crypto.randomBytes(16).toString('hex');
    grants.set(code, { challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, clientId: q.get('client_id')!, profile: p, used: false });
    const back = new URL(q.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state')!);
    return back.toString();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fake');
    const [, prov, endpoint] = url.pathname.split('/'); // /<google|github>/<endpoint>

    if (endpoint === 'authorize') {
      const q = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : url.searchParams;
      state.authorizeRequests.push(Object.fromEntries(q));
      for (const k of ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge']) {
        if (!q.get(k)) return json(res, 400, { error: 'invalid_request', missing: k });
      }
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' });
      if (q.get('client_id') !== CLIENT_ID) return json(res, 401, { error: 'invalid_client' });

      if (state.denyNext || q.get('deny')) {
        state.denyNext = false;
        const back = new URL(q.get('redirect_uri')!);
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', q.get('state')!);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (req.method === 'POST' || profile) {
        const p: FakeProfile = req.method === 'POST'
          ? { sub: q.get('sub') || `sub-${q.get('email')}`, email: q.get('email')!, name: q.get('name') || undefined, emailVerified: q.get('unverified') !== 'on' }
          : profile!;
        res.writeHead(302, { location: issueCode(q, p) });
        return res.end();
      }
      // interactive: a stand-in for the provider's account chooser
      const hidden = [...q].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>${esc(prov)} sign-in</title><h1>Sign in with ${esc(prov)} (fake)</h1>
        <form method="post">${hidden}
          <label>Email <input name="email" type="email" required></label>
          <label>Name <input name="name"></label>
          <label>Provider account id <input name="sub"></label>
          <label><input type="checkbox" name="unverified"> Email is not verified</label>
          <button type="submit">Authorize</button> <button type="submit" name="deny" value="1" formnovalidate>Deny</button></form>`);
    }

    if (endpoint === 'token' && req.method === 'POST') {
      const q = new URLSearchParams(await readBody(req));
      state.tokenRequests.push(Object.fromEntries(q));
      if (state.failTokenNext) {
        state.failTokenNext = false;
        return json(res, 500, { error: 'server_error' });
      }
      if (q.get('grant_type') !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
      if (q.get('client_id') !== CLIENT_ID || q.get('client_secret') !== CLIENT_SECRET) return json(res, 401, { error: 'invalid_client' });
      const g = grants.get(q.get('code') || '');
      if (!g || g.used) return json(res, 400, { error: 'invalid_grant', error_description: 'code unknown or already used' });
      g.used = true; // one-time
      if (g.redirectUri !== q.get('redirect_uri') || g.clientId !== q.get('client_id')) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (!q.get('code_verifier') || sha256url(q.get('code_verifier')!) !== g.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const token = crypto.randomBytes(16).toString('hex');
      tokens.set(token, g.profile);
      return json(res, 200, { access_token: token, token_type: 'bearer', scope: 'x' });
    }

    const p = tokens.get((req.headers.authorization || '').replace(/^Bearer /i, ''));
    if (!p) return json(res, 401, { error: 'invalid_token' });
    if (prov === 'google' && endpoint === 'userinfo') {
      return json(res, 200, { sub: p.sub, email: p.email, email_verified: p.emailVerified ?? true, name: p.name, picture: 'https://example.test/a.png' });
    }
    if (prov === 'github' && endpoint === 'user') return json(res, 200, { id: Number(p.sub) || p.sub, login: p.email.split('@')[0], name: p.name ?? null });
    if (prov === 'github' && endpoint === 'emails') {
      return json(res, 200, p.githubEmails ?? [{ email: p.email, primary: true, verified: p.emailVerified ?? true }]);
    }
    return json(res, 404, { error: 'not_found' });
  });

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    endpoints: {
      google: { authorize: `${base}/google/authorize`, token: `${base}/google/token`, userinfo: `${base}/google/userinfo` },
      github: { authorize: `${base}/github/authorize`, token: `${base}/github/token`, userinfo: `${base}/github/user`, emails: `${base}/github/emails` },
    },
    state,
    /** Sign-ins are approved automatically as this person until cleared. */
    setProfile: (p: FakeProfile | null) => { profile = p; },
    denyNext: () => { state.denyNext = true; },
    failTokenNext: () => { state.failTokenNext = true; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// `npx tsx tests/support/fakeOAuthProvider.ts` runs it standalone (the browser tests do this)
if (require.main === module) {
  createFakeProvider(Number(process.env.PORT || 4300)).then((p) => console.log(`fake OAuth provider on ${p.base}`));
}
