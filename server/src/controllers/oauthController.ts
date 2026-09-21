import { Request, Response, CookieOptions } from 'express';
import { env } from '../config/env';
import { setRefreshCookie } from './authController';
import { signRefresh } from '../services/auth/authService';
import { ok } from '../utils/http';
import { badRequest, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  STATE_COOKIE, OAuthError, begin, clientUrl, connections, disconnect, enabledProviders, handleCallback, isProviderId, providerEnabled, providerName,
} from '../services/auth/oauth';

// Sent back on the provider's top-level redirect, so SameSite=Lax is enough; scoped to the OAuth routes only.
const stateCookie: CookieOptions = { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/api/auth/oauth', maxAge: 600_000 };
const clearState = (res: Response) => res.clearCookie(STATE_COOKIE, { path: stateCookie.path });
const login = (query: string) => `${clientUrl()}/login?${query}`;

export function providers(_req: Request, res: Response) {
  res.json(ok({ providers: enabledProviders() }));
}

/** Browser navigation target for "Continue with …": sets the state cookie and bounces to the provider. */
export function start(req: Request, res: Response) {
  const id = req.params.provider;
  if (!providerEnabled(id)) return res.redirect(login('error=oauth_unavailable'));
  const { url, cookie } = begin(id, { returnTo: req.query.returnTo });
  res.cookie(STATE_COOKIE, cookie, stateCookie);
  res.redirect(url);
}

/** Signed-in users connecting a provider to their account. Returns the URL instead of redirecting because this is a fetch. */
export function link(req: Request, res: Response) {
  const id = req.params.provider;
  if (!providerEnabled(id)) throw notFound('Provider', 'OAUTH_PROVIDER_UNAVAILABLE');
  const { url, cookie } = begin(id, { linkUserId: String(req.user!._id) });
  res.cookie(STATE_COOKIE, cookie, stateCookie);
  res.json(ok({ url }));
}

export async function callback(req: Request, res: Response) {
  const id = req.params.provider;
  if (!isProviderId(id)) return res.redirect(login('error=oauth_unavailable'));
  try {
    const r = await handleCallback(id, { code: req.query.code, state: req.query.state, error: req.query.error }, req.cookies?.[STATE_COOKIE]);
    clearState(res); // single use
    if (r.kind === 'link') return res.redirect(`${clientUrl()}/app/settings?linked=${r.provider}`);
    setRefreshCookie(res, signRefresh(r.user));
    res.redirect(`${clientUrl()}${r.returnTo}`);
  } catch (e) {
    clearState(res);
    const err = e instanceof OAuthError ? e : new OAuthError('oauth_failed', String(e));
    logger.warn('oauth sign-in failed', { provider: id, code: err.code, detail: err.detail });
    // Only the short code is exposed; the reason stays in the log.
    res.redirect(err.toSettings ? `${clientUrl()}/app/settings?error=${err.code}` : login(`error=${err.code}`));
  }
}

export async function list(req: Request, res: Response) {
  res.json(ok(await connections(req.user!._id)));
}

export async function unlink(req: Request, res: Response) {
  const id = req.params.provider;
  if (!isProviderId(id)) throw notFound('Provider', 'OAUTH_PROVIDER_UNAVAILABLE');
  const r = await disconnect(req.user!._id, id);
  if (!r.ok) {
    throw badRequest(
      r.code === 'LAST_SIGN_IN_METHOD' ? `${providerName(id)} is your only way to sign in. Set a password first (use "Forgot password"), then disconnect it.` : `${providerName(id)} is not connected`,
      r.code,
    );
  }
  res.json(ok({ disconnected: id }));
}
