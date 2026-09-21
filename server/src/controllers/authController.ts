import { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { User, publicUser } from '../models/User';
import { Member } from '../models/Workspace';
import * as auth from '../services/auth/authService';
import { body, ok } from '../utils/http';
import { badRequest, unauthorized } from '../utils/errors';
import { verificationRequired } from '../config/mail';

const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const COOKIE = 'refresh_token';

export const setRefreshCookie = (res: Response, token: string) =>
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: auth.REFRESH_TTL_MS,
  });

async function session(res: Response, user: Awaited<ReturnType<typeof auth.login>>) {
  setRefreshCookie(res, auth.signRefresh(user));
  const memberships = await Member.find({ userId: user._id }).populate('workspaceId');
  return {
    user: publicUser(user),
    accessToken: auth.signAccess(user),
    workspaces: memberships.map((m) => ({ ...(m.workspaceId as any).toJSON(), role: m.role })),
  };
}

export async function register(req: Request, res: Response) {
  const input = body(
    z.object({ name: z.string().trim().min(1).max(100), email: z.string().email(), password, workspaceName: z.string().trim().min(1).max(80).optional() }),
    req,
  );
  const { user, verificationToken } = await auth.register(input);
  // Like the password-reset token, the verification token is only echoed outside production, so the flow can be used and
  // tested without a mail server. In production it exists only inside the emailed link.
  const dev = env.NODE_ENV !== 'production' && verificationToken ? { devVerifyToken: verificationToken } : {};
  res.status(201).json(ok({ ...(await session(res, user)), ...dev }));
}

export async function login(req: Request, res: Response) {
  const { email, password: pw } = body(z.object({ email: z.string().email(), password: z.string().min(1) }), req);
  const user = await auth.login(email, pw);
  res.json(ok(await session(res, user)));
}

/** Redeems the emailed link. Public: people often open it in a different browser from the one they signed up in. */
export async function verifyEmail(req: Request, res: Response) {
  const { token } = body(z.object({ token: z.string().min(10).max(200) }), req);
  await auth.verifyEmail(token);
  res.json(ok({ verified: true }));
}

export async function resendVerification(req: Request, res: Response) {
  if (!verificationRequired()) throw badRequest('This server does not require email verification', 'VERIFICATION_NOT_REQUIRED');
  if (req.user!.emailVerified) return res.json(ok({ alreadyVerified: true }));
  const token = await auth.sendVerification(req.user!, { cooldown: true });
  res.json(ok({ sent: true, ...(env.NODE_ENV !== 'production' ? { devToken: token } : {}) }));
}

export async function refresh(req: Request, res: Response) {
  const token = req.cookies?.[COOKIE];
  if (!token) throw unauthorized('No session', 'REFRESH_INVALID');
  const user = await auth.refresh(token);
  res.json(ok(await session(res, user)));
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.json(ok({ loggedOut: true }));
}

export async function logoutAll(req: Request, res: Response) {
  await auth.logoutAll(req.user!._id);
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.json(ok({ loggedOut: true }));
}

export async function forgotPassword(req: Request, res: Response) {
  const { email } = body(z.object({ email: z.string().email() }), req);
  const token = await auth.forgotPassword(email);
  // Same response whether or not the account exists. The token is only echoed in non-production so the flow is testable without email.
  res.json(ok({ message: 'If that account exists, a reset link has been sent.', ...(env.NODE_ENV !== 'production' && token ? { devToken: token } : {}) }));
}

export async function resetPassword(req: Request, res: Response) {
  const { token, password: pw } = body(z.object({ token: z.string().min(10), password }), req);
  await auth.resetPassword(token, pw);
  res.json(ok({ message: 'Password updated. Please sign in.' }));
}

export async function me(req: Request, res: Response) {
  const memberships = await Member.find({ userId: req.user!._id }).populate('workspaceId');
  res.json(ok({ user: publicUser(req.user!), workspaces: memberships.map((m) => ({ ...(m.workspaceId as any).toJSON(), role: m.role })) }));
}

export async function updateProfile(req: Request, res: Response) {
  const input = body(z.object({ name: z.string().trim().min(1).max(100).optional(), title: z.string().max(100).optional(), avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }), req);
  const user = await User.findByIdAndUpdate(req.user!._id, input, { new: true });
  res.json(ok({ user: publicUser(user!) }));
}

export async function changePassword(req: Request, res: Response) {
  const { currentPassword, newPassword } = body(z.object({ currentPassword: z.string(), newPassword: password }), req);
  const user = await auth.changePassword(req.user!._id, currentPassword, newPassword);
  res.json(ok(await session(res, user)));
}
