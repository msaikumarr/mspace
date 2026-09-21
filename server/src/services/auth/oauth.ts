import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { User, UserDoc } from '../../models/User';
import { markEmailVerified, registerOAuth } from './authService';
import { logger } from '../../utils/logger';

/**
 * Social sign-in (Google, GitHub) with the OAuth 2.0 authorization-code flow.
 *
 * - PKCE (S256) protects the code, and a random `state` echoed by the provider and matched against a signed,
 *   short-lived, httpOnly cookie ties the callback to the browser that started it (stops login CSRF).
 * - Tokens are never put in a URL: the callback sets the normal refresh cookie and redirects into the app.
 * - An account is only created from, or linked by, an email the provider says is verified.
 * - A verified provider email is never silently attached to an existing password account whose email has not been
 *   verified (someone could have pre-registered the address). Those users connect the provider from Settings
 *   while signed in instead.
 */
export type ProviderId = 'google' | 'github';
export const PROVIDER_IDS: ProviderId[] = ['google', 'github'];
export const STATE_COOKIE = 'oauth_state';
const STATE_TTL_S = 600;
const HTTP_TIMEOUT_MS = 10_000;

/** Failure with a short code the client turns into a message; `detail` is only for the server log. */
export class OAuthError extends Error {
  constructor(public code: string, public detail?: string, public toSettings = false) {
    super(code);
  }
}

export interface Profile { subject: string; email: string; emailVerified: boolean; name: string }
interface Endpoints { authorize: string; token: string; userinfo: string; emails?: string }
interface ProviderConfig { id: ProviderId; name: string; scope: string; clientId?: string; clientSecret?: string; endpoints: Endpoints }
interface OAuthConfig { providers: Record<ProviderId, ProviderConfig>; redirectBase: string; clientUrl: string }

const DEFAULTS: Record<ProviderId, Omit<ProviderConfig, 'clientId' | 'clientSecret'>> = {
  google: {
    id: 'google', name: 'Google', scope: 'openid email profile',
    endpoints: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', userinfo: 'https://openidconnect.googleapis.com/v1/userinfo' },
  },
  github: {
    id: 'github', name: 'GitHub', scope: 'read:user user:email',
    endpoints: { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', userinfo: 'https://api.github.com/user', emails: 'https://api.github.com/user/emails' },
  },
};

const firstClientUrl = () => env.CLIENT_URL.split(',')[0].trim().replace(/\/$/, '');

function fromEnv(): OAuthConfig {
  const overrides = env.OAUTH_ENDPOINTS_JSON ? (JSON.parse(env.OAUTH_ENDPOINTS_JSON) as Partial<Record<ProviderId, Partial<Endpoints>>>) : {};
  const build = (id: ProviderId, clientId?: string, clientSecret?: string): ProviderConfig => ({
    ...DEFAULTS[id], clientId: clientId || undefined, clientSecret: clientSecret || undefined, endpoints: { ...DEFAULTS[id].endpoints, ...overrides[id] },
  });
  return {
    providers: {
      google: build('google', env.OAUTH_GOOGLE_CLIENT_ID, env.OAUTH_GOOGLE_CLIENT_SECRET),
      github: build('github', env.OAUTH_GITHUB_CLIENT_ID, env.OAUTH_GITHUB_CLIENT_SECRET),
    },
    redirectBase: (env.OAUTH_REDIRECT_BASE || firstClientUrl()).replace(/\/$/, ''),
    clientUrl: firstClientUrl(),
  };
}

let cfg = fromEnv();

/** Test hook: replace parts of the configuration. Call with no argument to restore the environment. */
export function configureOAuth(o?: { providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>>; redirectBase?: string; clientUrl?: string }) {
  const base = fromEnv();
  cfg = {
    ...base, ...(o?.redirectBase ? { redirectBase: o.redirectBase } : {}), ...(o?.clientUrl ? { clientUrl: o.clientUrl } : {}),
    providers: {
      google: { ...base.providers.google, ...o?.providers?.google, endpoints: { ...base.providers.google.endpoints, ...o?.providers?.google?.endpoints } },
      github: { ...base.providers.github, ...o?.providers?.github, endpoints: { ...base.providers.github.endpoints, ...o?.providers?.github?.endpoints } },
    },
  };
}

export const clientUrl = () => cfg.clientUrl;
export const isProviderId = (s: unknown): s is ProviderId => PROVIDER_IDS.includes(s as ProviderId);
const isEnabled = (id: ProviderId) => !!(cfg.providers[id].clientId && cfg.providers[id].clientSecret);
export const enabledProviders = () => PROVIDER_IDS.filter(isEnabled).map((id) => ({ id, name: cfg.providers[id].name }));
export const providerName = (id: ProviderId) => cfg.providers[id].name;
export const providerEnabled = (id: unknown): id is ProviderId => isProviderId(id) && isEnabled(id);

/** Only in-app paths are honoured, so the callback can never be used as an open redirect. */
export function safeReturnTo(r: unknown): string {
  if (typeof r !== 'string' || r.length > 300) return '/app';
  if (!(r === '/app' || r.startsWith('/app/') || r.startsWith('/app?'))) return '/app';
  if (/[\\\s\x00-\x1f]/.test(r) || r.includes('//')) return '/app';
  return r;
}

const b64url = (b: Buffer) => b.toString('base64url');
const redirectUri = (id: ProviderId) => `${cfg.redirectBase}/api/auth/oauth/${id}/callback`;

interface StatePayload { typ: 'oauth_state'; p: ProviderId; s: string; v: string; r: string; l?: string }

/** Starts an authorization: returns the provider URL to send the browser to, and the state cookie value to set. */
export function begin(id: ProviderId, opts: { returnTo?: unknown; linkUserId?: string } = {}) {
  const p = cfg.providers[id];
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = b64url(crypto.randomBytes(32));
  const payload: StatePayload = { typ: 'oauth_state', p: id, s: state, v: verifier, r: safeReturnTo(opts.returnTo), ...(opts.linkUserId ? { l: opts.linkUserId } : {}) };
  const url = new URL(p.endpoints.authorize);
  url.search = new URLSearchParams({
    client_id: p.clientId!, redirect_uri: redirectUri(id), response_type: 'code', scope: p.scope, state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), cookie: jwt.sign(payload, env.JWT_SECRET, { expiresIn: STATE_TTL_S }) };
}

function readState(cookie: unknown, id: ProviderId): StatePayload {
  try {
    const p = jwt.verify(String(cookie ?? ''), env.JWT_SECRET) as StatePayload;
    if (p.typ !== 'oauth_state' || p.p !== id) throw new Error('wrong state token');
    return p;
  } catch {
    throw new OAuthError('oauth_state', 'missing, expired or mismatched state cookie');
  }
}

async function http(url: string, init: RequestInit, what: string) {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e) {
    throw new OAuthError('oauth_failed', `${what}: ${String(e)}`);
  }
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new OAuthError('oauth_failed', `${what}: HTTP ${res.status} ${json?.error ?? ''}`);
  return json;
}

async function exchangeCode(id: ProviderId, code: string, verifier: string) {
  const p = cfg.providers[id];
  const json = await http(p.endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(id), client_id: p.clientId!, client_secret: p.clientSecret!, code_verifier: verifier }),
  }, 'token exchange');
  if (!json?.access_token) throw new OAuthError('oauth_failed', `token exchange: ${json?.error ?? 'no access_token'}`);
  return String(json.access_token);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'M-Space' });

async function fetchProfile(id: ProviderId, token: string): Promise<Profile> {
  const { endpoints } = cfg.providers[id];
  if (id === 'google') {
    const u = await http(endpoints.userinfo, { headers: bearer(token) }, 'userinfo');
    if (!u?.sub || !u?.email) throw new OAuthError('oauth_failed', 'userinfo missing sub or email');
    return { subject: String(u.sub), email: String(u.email).toLowerCase(), emailVerified: u.email_verified === true || u.email_verified === 'true', name: String(u.name || '') };
  }
  const [u, emails] = await Promise.all([http(endpoints.userinfo, { headers: bearer(token) }, 'user'), http(endpoints.emails!, { headers: bearer(token) }, 'user emails')]);
  if (!u?.id || !Array.isArray(emails)) throw new OAuthError('oauth_failed', 'github profile incomplete');
  // GitHub lets people hide their email, so ask for the list and take a primary, verified address.
  const best = emails.find((e: any) => e.primary && e.verified) || emails.find((e: any) => e.verified);
  return { subject: String(u.id), email: String(best?.email || '').toLowerCase(), emailVerified: !!best, name: String(u.name || u.login || '') };
}

const displayName = (p: Profile) => (p.name.trim() || p.email.split('@')[0]).slice(0, 100);

export type CallbackResult = { kind: 'login'; user: UserDoc; returnTo: string } | { kind: 'link'; user: UserDoc; provider: ProviderId };

/** Handles the provider's redirect back to us. Throws OAuthError (with a safe code) on any failure. */
export async function handleCallback(id: ProviderId, q: { code?: unknown; state?: unknown; error?: unknown }, stateCookie: unknown): Promise<CallbackResult> {
  const st = readState(stateCookie, id);
  const linking = !!st.l;
  try {
    if (q.error) throw new OAuthError('oauth_denied', `provider returned error=${String(q.error).slice(0, 60)}`);
    // Both must match: the cookie proves this browser started the flow, the echoed state proves the redirect belongs to it.
    if (typeof q.state !== 'string' || q.state.length !== st.s.length || !crypto.timingSafeEqual(Buffer.from(q.state), Buffer.from(st.s))) {
      throw new OAuthError('oauth_state', 'state parameter does not match');
    }
    if (typeof q.code !== 'string' || !q.code) throw new OAuthError('oauth_failed', 'no authorization code');

    const profile = await fetchProfile(id, await exchangeCode(id, q.code, st.v));
    if (!profile.email || !profile.emailVerified) throw new OAuthError('oauth_email_unverified', `${id} email missing or unverified`);

    if (linking) return { kind: 'link', user: await linkIdentity(st.l!, id, profile), provider: id };
    return { kind: 'login', user: await signIn(id, profile), returnTo: st.r };
  } catch (e) {
    if (e instanceof OAuthError) e.toSettings = linking;
    else logger.error('oauth callback failed unexpectedly', { provider: id, err: String(e) });
    throw e instanceof OAuthError ? e : Object.assign(new OAuthError('oauth_failed', String(e)), { toSettings: linking });
  }
}

async function signIn(id: ProviderId, profile: Profile): Promise<UserDoc> {
  const byIdentity = await User.findOne({ identities: { $elemMatch: { provider: id, subject: profile.subject } } });
  if (byIdentity) {
    byIdentity.lastActiveAt = new Date();
    await byIdentity.save();
    return byIdentity;
  }

  const existing = await User.findOne({ email: profile.email });
  if (existing) {
    // Attaching to an account whose email nobody has proven ownership of would let whoever registered it first keep
    // access through their password. Those users connect the provider from Settings after signing in.
    if (!existing.emailVerified) throw new OAuthError('oauth_email_exists', `existing unverified account for ${profile.email}`);
    existing.identities.push({ provider: id, subject: profile.subject, email: profile.email, linkedAt: new Date() });
    existing.lastActiveAt = new Date();
    await existing.save();
    return existing;
  }

  try {
    return await registerOAuth({ name: displayName(profile), email: profile.email, provider: id, subject: profile.subject });
  } catch (e: any) {
    if (e?.code === 11000) throw new OAuthError('oauth_failed', 'concurrent sign-up for the same account'); // two tabs racing; retrying works
    throw e;
  }
}

async function linkIdentity(userId: string, id: ProviderId, profile: Profile): Promise<UserDoc> {
  const user = await User.findById(userId);
  if (!user) throw new OAuthError('oauth_failed', 'linking user no longer exists');
  const owner = await User.findOne({ identities: { $elemMatch: { provider: id, subject: profile.subject } } }).select('_id');
  if (owner && String(owner._id) !== String(user._id)) throw new OAuthError('oauth_already_linked', `${id} identity belongs to another account`);
  if (!user.identities.some((i) => i.provider === id)) {
    user.identities.push({ provider: id, subject: profile.subject, email: profile.email, linkedAt: new Date() });
  }
  await user.save();
  // The person is signed in here and just proved control of the provider's verified address; if it is this account's own
  // address that also proves ownership of it (and releases whatever was waiting on that).
  if (profile.email === user.email && (await markEmailVerified(user._id))) user.emailVerified = true;
  return user;
}

/** What Settings shows: every provider, whether it can be used, and whether the account has it connected. */
export async function connections(userId: unknown) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) return null;
  return {
    hasPassword: !!user.passwordHash,
    providers: PROVIDER_IDS.map((id) => {
      const linked = user.identities.find((i) => i.provider === id);
      return { id, name: cfg.providers[id].name, enabled: isEnabled(id), connected: !!linked, email: linked?.email };
    }).filter((p) => p.enabled || p.connected),
  };
}

/** Removes a connected provider, provided the account can still sign in some other way. */
export async function disconnect(userId: unknown, id: ProviderId) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !user.identities.some((i) => i.provider === id)) return { ok: false as const, code: 'NOT_CONNECTED' };
  if (!user.passwordHash && user.identities.length <= 1) return { ok: false as const, code: 'LAST_SIGN_IN_METHOD' };
  user.identities = user.identities.filter((i) => i.provider !== id) as typeof user.identities;
  await user.save();
  return { ok: true as const };
}
