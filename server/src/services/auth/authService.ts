import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env, adminEmails } from '../../config/env';
import { User, UserDoc } from '../../models/User';
import { Invite, Member } from '../../models/Workspace';
import { AppError, conflict, unauthorized, badRequest } from '../../utils/errors';
import { appUrl, verificationRequired } from '../../config/mail';
import { createWorkspace } from '../workspaceService';
import { audit } from '../auditService';
import { notify } from '../notifications/notificationService';
import { sendEmail } from '../notifications/email';
import { inviteMessage, resetPasswordMessage, verifyEmailMessage } from '../notifications/mailTemplates';

const ROUNDS = env.NODE_ENV === 'test' ? 4 : 12;
const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#ef4444', '#14b8a6'];

export const ACCESS_TTL = '15m';
export const REFRESH_TTL_MS = 7 * 24 * 3600 * 1000;

export const signAccess = (u: UserDoc) => jwt.sign({ sub: String(u._id), tv: u.tokenVersion, typ: 'access' }, env.JWT_SECRET, { expiresIn: ACCESS_TTL });
export const signRefresh = (u: UserDoc) => jwt.sign({ sub: String(u._id), tv: u.tokenVersion, typ: 'refresh' }, env.JWT_SECRET, { expiresIn: '7d' });

export function verifyToken(token: string, typ: 'access' | 'refresh') {
  try {
    const p = jwt.verify(token, env.JWT_SECRET) as { sub: string; tv: number; typ: string };
    if (p.typ !== typ) throw new Error('wrong token type');
    return p;
  } catch {
    throw unauthorized('Invalid or expired token', typ === 'access' ? 'TOKEN_INVALID' : 'REFRESH_INVALID');
  }
}

export async function register(input: { name: string; email: string; password: string; workspaceName?: string }) {
  const email = input.email.toLowerCase();
  if (await User.exists({ email })) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');

  // When addresses must be verified, nothing that trusts the address is granted until it is: not the invitations that
  // were waiting for it, and not platform-admin status for a matching ADMIN_EMAILS entry. Both are released by verification.
  const mustVerify = verificationRequired();
  const user = await User.create({
    name: input.name,
    email,
    passwordHash: await bcrypt.hash(input.password, ROUNDS),
    avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)],
    isPlatformAdmin: !mustVerify && adminEmails.includes(email),
  });

  let verificationToken: string | undefined;
  if (mustVerify) verificationToken = await sendVerification(user);
  else await acceptPendingInvites(user, email);
  const workspace = await createWorkspace(user, input.workspaceName || `${input.name.split(' ')[0]}'s Workspace`);
  return { user, workspace, verificationToken };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const VERIFY_TTL_MS = 24 * 3600 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Emails a fresh confirmation link (replacing any earlier one) and returns its token so development can show the link
 * when no mail server is configured. Only the token's hash is stored. With `cooldown`, refuses to send again too soon.
 */
export async function sendVerification(user: UserDoc, opts: { cooldown?: boolean } = {}) {
  const u = await User.findById(user._id).select('+verifySentAt');
  if (!u) throw unauthorized('Account not found');
  if (opts.cooldown && u.verifySentAt) {
    const wait = RESEND_COOLDOWN_MS - (Date.now() - u.verifySentAt.getTime());
    if (wait > 0) throw new AppError(429, 'RESEND_TOO_SOON', `Please wait ${Math.ceil(wait / 1000)} seconds before asking for another email.`, { retryAfterSeconds: Math.ceil(wait / 1000) });
  }
  const token = crypto.randomBytes(32).toString('hex');
  u.verifyTokenHash = sha256(token);
  u.verifyTokenExpires = new Date(Date.now() + VERIFY_TTL_MS);
  await u.save();
  const m = verifyEmailMessage(u.name, `${appUrl()}/verify-email?token=${token}`);
  // The cooldown only counts emails that actually went out, so a mail outage does not also block the retry.
  if ((await sendEmail(u.email, m.subject, m.text, m.html)).sent) {
    u.verifySentAt = new Date();
    await u.save();
  }
  return token;
}

/**
 * The one place an address becomes verified. Releases everything that was waiting on it: invitations sent to the address,
 * and platform-admin status for an ADMIN_EMAILS match. Returns false if it already was verified.
 */
export async function markEmailVerified(userId: unknown) {
  const user = await User.findById(userId);
  if (!user || user.emailVerified) return false;
  const admin = adminEmails.includes(user.email);
  await User.updateOne({ _id: user._id }, { $set: { emailVerified: true, ...(admin ? { isPlatformAdmin: true } : {}) }, $unset: { verifyTokenHash: 1, verifyTokenExpires: 1 } });
  await acceptPendingInvites(user, user.email);
  return true;
}

/** Redeems an emailed link. Links are single-use, expire after 24 hours, and are replaced when a new one is sent. */
export async function verifyEmail(token: string) {
  const user = await User.findOne({ verifyTokenHash: sha256(token), verifyTokenExpires: { $gt: new Date() } });
  if (!user) throw badRequest('This confirmation link is invalid, has expired, or has already been used.', 'VERIFY_TOKEN_INVALID');
  await markEmailVerified(user._id);
  return (await User.findById(user._id))!;
}

/** Tells someone they were invited, when they have no way to see it inside the app yet. */
export async function sendInviteEmail(to: string, inviter: string, workspace: string, role: string) {
  const m = inviteMessage(inviter, workspace, role, `${appUrl()}/login`);
  await sendEmail(to, m.subject, m.text, m.html);
}

/** Invitations sent before the user had an account are honoured when they sign up. */
async function acceptPendingInvites(user: UserDoc, email: string) {
  const invites = await Invite.find({ email });
  for (const inv of invites) {
    await Member.updateOne({ workspaceId: inv.workspaceId, userId: user._id }, { $setOnInsert: { role: inv.role } }, { upsert: true });
    await notify({ workspaceId: inv.workspaceId, userIds: [user._id], type: 'INVITATION', title: 'You joined a workspace', link: '/app' });
    await audit({ workspaceId: inv.workspaceId, actorId: user._id, action: 'INVITE_ACCEPTED', targetType: 'user', targetId: String(user._id) });
  }
  await Invite.deleteMany({ email });
}

/** Creates an account from a social sign-in whose provider vouched for the email. There is no password. */
export async function registerOAuth(input: { name: string; email: string; provider: string; subject: string }) {
  const email = input.email.toLowerCase();
  const user = await User.create({
    name: input.name,
    email,
    emailVerified: true,
    identities: [{ provider: input.provider, subject: input.subject, email }],
    avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)],
    isPlatformAdmin: adminEmails.includes(email),
  });
  await acceptPendingInvites(user, email);
  await createWorkspace(user, `${input.name.split(' ')[0]}'s Workspace`);
  return user;
}

export async function login(emailRaw: string, password: string) {
  const user = await User.findOne({ email: emailRaw.toLowerCase() }).select('+passwordHash');
  // compare against a dummy hash when the user is missing so timing does not reveal account existence
  const hash = user?.passwordHash || '$2a$04$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const okPw = await bcrypt.compare(password, hash);
  if (!user || !okPw) throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  user.lastActiveAt = new Date();
  await user.save();
  return user;
}

export async function refresh(token: string) {
  const p = verifyToken(token, 'refresh');
  const user = await User.findById(p.sub);
  if (!user || user.tokenVersion !== p.tv) throw unauthorized('Session expired', 'REFRESH_INVALID');
  return user;
}

/** Invalidates every outstanding access + refresh token for the user. */
export async function logoutAll(userId: unknown) {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

export async function forgotPassword(emailRaw: string) {
  const user = await User.findOne({ email: emailRaw.toLowerCase() });
  if (!user) return null; // caller responds identically either way (no account enumeration)
  const token = crypto.randomBytes(32).toString('hex');
  user.resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  user.resetTokenExpires = new Date(Date.now() + 3600 * 1000);
  await user.save();
  const m = resetPasswordMessage(`${appUrl()}/reset-password?token=${token}`);
  await sendEmail(user.email, m.subject, m.text, m.html);
  return token;
}

export async function resetPassword(token: string, password: string) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({ resetTokenHash: hash, resetTokenExpires: { $gt: new Date() } }).select('+resetTokenHash +resetTokenExpires');
  if (!user) throw badRequest('Reset link is invalid or has expired', 'RESET_TOKEN_INVALID');
  user.passwordHash = await bcrypt.hash(password, ROUNDS);
  user.resetTokenHash = undefined;
  user.resetTokenExpires = undefined;
  user.tokenVersion += 1; // sign out everywhere
  await user.save();
  await markEmailVerified(user._id); // the reset link went to their inbox, so it proves they control the address
}

export async function changePassword(userId: unknown, current: string, next: string) {
  const user = await User.findById(userId).select('+passwordHash');
  if (user && !user.passwordHash) throw badRequest('This account has no password yet. Use "Forgot password" to set one.', 'NO_PASSWORD');
  if (!user || !(await bcrypt.compare(current, user.passwordHash!))) throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
  user.passwordHash = await bcrypt.hash(next, ROUNDS);
  user.tokenVersion += 1;
  await user.save();
  return user;
}
