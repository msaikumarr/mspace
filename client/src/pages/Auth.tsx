import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, refreshSession } from '../services/api';
import { useAuth } from '../store/auth';
import { Button, ErrorBox, Field, Input } from '../components/ui';

/** Neither brand mark is in lucide-react (it carries no brand/logo icons), so both are drawn directly. */
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.48a5.6 5.6 0 0 1-2.4 3.62v3h3.87c2.27-2.09 3.57-5.17 3.57-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.9l-3.87-3c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.96H1.27v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.6H1.27A12 12 0 0 0 0 12c0 1.94.46 3.77 1.27 5.4Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.94 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.6l4 3.11C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}
const SOCIAL_ICON: Record<string, ReactNode> = { google: <GoogleIcon className="h-[18px] w-[18px]" />, github: <GitHubIcon className="h-[18px] w-[18px] text-slate-900" /> };

function Shell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-50 via-white to-slate-100 px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2 text-xl font-bold text-slate-900">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">M</span> M-Space
        </Link>
        <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
          <p className="mb-5 mt-1 text-sm text-slate-500">{subtitle}</p>
          {children}
        </div>
        <p className="mt-4 text-center text-sm text-slate-500">{footer}</p>
      </div>
    </div>
  );
}

/** What the user is told for each failure code the server puts in `?error=` after a social sign-in attempt. */
const OAUTH_ERRORS: Record<string, string> = {
  oauth_denied: 'Sign-in was cancelled.',
  oauth_state: 'That sign-in attempt expired or did not start on this device. Please try again.',
  oauth_failed: 'We could not complete sign-in with that provider. Please try again.',
  oauth_unavailable: 'That sign-in method is not available.',
  oauth_email_unverified: 'Your provider has not verified your email address, so we cannot use it to sign you in.',
  oauth_email_exists: 'An account with this email already exists. Sign in with your password, then connect the provider from Settings → Account.',
  oauth_already_linked: 'That account is already connected to a different M-Space user.',
};
export const oauthMessage = (code: string | null) => (code ? OAUTH_ERRORS[code] || 'Sign-in failed. Please try again.' : null);

/** "Continue with …" for each provider the server has configured; renders nothing when there are none. */
function SocialButtons({ verb, returnTo }: { verb: string; returnTo?: string }) {
  const [params] = useSearchParams();
  const providers = useQuery({ queryKey: ['oauth-providers'], queryFn: () => api<{ providers: { id: string; name: string }[] }>('/auth/oauth/providers', { noWorkspace: true }), staleTime: 60_000 });
  const error = oauthMessage(params.get('error'));
  const list = providers.data?.providers || [];
  const q = returnTo?.startsWith('/app') ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
  return (
    <>
      {error && <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {list.length > 0 && (
        <div className="mt-5">
          <div className="mb-4 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" /></div>
          <div className="space-y-2">
            {list.map((p) => (
              // a full-page navigation: the provider redirects back to the server, which then sends the browser into the app
              <a key={p.id} href={`/api/auth/oauth/${p.id}/start${q}`} className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                {SOCIAL_ICON[p.id]}{verb} with {p.name}
              </a>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const email = z.string().trim().email('Enter a valid email');
const password = z.string().min(8, 'At least 8 characters');

export function Login() {
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const { register, handleSubmit, formState: { errors } } = useForm({ resolver: zodResolver(z.object({ email, password: z.string().min(1, 'Required') })) });
  const m = useMutation({
    mutationFn: (v: { email: string; password: string }) => api('/auth/login', { method: 'POST', body: v, noWorkspace: true }),
    onSuccess: (d) => { useAuth.getState().setSession(d); nav(loc.state?.from || '/app', { replace: true }); },
  });
  return (
    <Shell title="Welcome back" subtitle="Sign in to your workspace" footer={<>New here? <Link className="font-medium text-brand-600" to="/register">Create an account</Link></>}>
      <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
        <Field label="Email" error={errors.email?.message}><Input type="email" autoComplete="email" autoFocus {...register('email')} /></Field>
        <Field label="Password" error={errors.password?.message}><Input type="password" autoComplete="current-password" {...register('password')} /></Field>
        <ErrorBox error={m.error} />
        <Button type="submit" loading={m.isPending} className="w-full">Sign in</Button>
        <div className="text-right text-sm"><Link className="text-slate-500 hover:text-brand-600" to="/forgot-password">Forgot password?</Link></div>
      </form>
      <SocialButtons verb="Continue" returnTo={loc.state?.from} />
    </Shell>
  );
}

export function Register() {
  const nav = useNavigate();
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(z.object({ name: z.string().trim().min(1, 'Required').max(100), email, password, workspaceName: z.string().trim().max(80).optional() })),
  });
  const m = useMutation({
    mutationFn: (v: object) => api('/auth/register', { method: 'POST', body: { ...v, workspaceName: (v as any).workspaceName || undefined }, noWorkspace: true }),
    onSuccess: (d) => { useAuth.getState().setSession(d); nav('/app', { replace: true }); },
  });
  return (
    <Shell title="Create your account" subtitle="Your first workspace is created automatically" footer={<>Already have an account? <Link className="font-medium text-brand-600" to="/login">Sign in</Link></>}>
      <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
        <Field label="Full name" error={errors.name?.message}><Input autoComplete="name" autoFocus {...register('name')} /></Field>
        <Field label="Work email" error={errors.email?.message}><Input type="email" autoComplete="email" {...register('email')} /></Field>
        <Field label="Password" error={errors.password?.message} hint="At least 8 characters"><Input type="password" autoComplete="new-password" {...register('password')} /></Field>
        <Field label="Workspace name (optional)" error={errors.workspaceName?.message}><Input placeholder="Acme Inc." {...register('workspaceName')} /></Field>
        <ErrorBox error={m.error} />
        <Button type="submit" loading={m.isPending} className="w-full">Create account</Button>
      </form>
      <SocialButtons verb="Sign up" />
    </Shell>
  );
}

export function ForgotPassword() {
  const [devToken, setDevToken] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm({ resolver: zodResolver(z.object({ email })) });
  const m = useMutation({
    mutationFn: (v: { email: string }) => api<{ message: string; devToken?: string }>('/auth/forgot-password', { method: 'POST', body: v, noWorkspace: true }),
    onSuccess: (d) => setDevToken(d.devToken || null),
  });
  return (
    <Shell title="Reset your password" subtitle="We'll email you a reset link" footer={<Link className="font-medium text-brand-600" to="/login">Back to sign in</Link>}>
      {m.isSuccess ? (
        <div className="space-y-3 text-sm">
          <p className="rounded-lg bg-emerald-50 p-3 text-emerald-800">{m.data.message}</p>
          {devToken && (
            <p className="rounded-lg bg-amber-50 p-3 text-amber-900">
              Development mode: no email provider is configured, so use <Link className="font-medium underline" to={`/reset-password?token=${devToken}`}>this reset link</Link>.
            </p>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
          <Field label="Email" error={errors.email?.message}><Input type="email" autoFocus {...register('email')} /></Field>
          <ErrorBox error={m.error} />
          <Button type="submit" loading={m.isPending} className="w-full">Send reset link</Button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { register, handleSubmit, formState: { errors } } = useForm({ resolver: zodResolver(z.object({ password, confirm: z.string() }).refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] })) });
  const m = useMutation({
    mutationFn: (v: { password: string }) => api('/auth/reset-password', { method: 'POST', body: { token: params.get('token'), password: v.password }, noWorkspace: true }),
    onSuccess: () => nav('/login', { replace: true }),
  });
  return (
    <Shell title="Choose a new password" subtitle="You'll be signed out of all devices" footer={<Link className="font-medium text-brand-600" to="/login">Back to sign in</Link>}>
      <form onSubmit={handleSubmit((v) => m.mutate(v))} className="space-y-4" noValidate>
        <Field label="New password" error={errors.password?.message}><Input type="password" autoComplete="new-password" autoFocus {...register('password')} /></Field>
        <Field label="Confirm password" error={errors.confirm?.message}><Input type="password" autoComplete="new-password" {...register('confirm')} /></Field>
        <ErrorBox error={m.error} />
        <Button type="submit" loading={m.isPending} className="w-full">Update password</Button>
      </form>
    </Shell>
  );
}

type Verification = { state: 'checking' } | { state: 'done' } | { state: 'failed'; message: string };

/** Where the emailed "Confirm email" link lands. Public, because it is often opened in a different browser than the one signed in. */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const { user } = useAuth();
  const [result, setResult] = useState<Verification>(token ? { state: 'checking' } : { state: 'failed', message: 'This link is incomplete. Open the whole link from the email.' });
  const started = useRef(false); // effects run twice in development, and a link can only be used once
  const resend = useMutation({
    mutationFn: () => api<{ sent?: boolean; alreadyVerified?: boolean }>('/auth/resend-verification', { method: 'POST', noWorkspace: true }),
  });

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api('/auth/verify-email', { method: 'POST', body: { token }, noWorkspace: true })
      .then(async () => {
        await refreshSession({ fresh: true }); // if this browser is signed in, pick up the new state (not a stale in-flight one)
        setResult({ state: 'done' });
      })
      .catch((e: Error) => setResult({ state: 'failed', message: e.message }));
  }, [token]);

  const signedIn = !!user;
  return (
    <Shell
      title={result.state === 'done' ? 'Email confirmed' : result.state === 'failed' ? 'We could not confirm your email' : 'Confirming your email…'}
      subtitle={result.state === 'done' ? 'Thanks, your address is verified.' : ''}
      footer={<Link className="font-medium text-brand-600" to={signedIn ? '/app' : '/login'}>{signedIn ? 'Go to the app' : 'Back to sign in'}</Link>}
    >
      {result.state === 'checking' && <p className="text-sm text-slate-500" role="status">One moment…</p>}
      {result.state === 'done' && (
        <div className="space-y-3 text-sm">
          <p className="rounded-lg bg-emerald-50 p-3 text-emerald-800" role="status">Any workspace invitations sent to this address have been applied.</p>
          <Link to={signedIn ? '/app' : '/login'}><Button className="w-full">{signedIn ? 'Continue to M-Space' : 'Sign in'}</Button></Link>
        </div>
      )}
      {result.state === 'failed' && (
        <div className="space-y-3 text-sm">
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">{result.message}</p>
          {signedIn && user.needsEmailVerification ? (
            resend.isSuccess
              ? <p className="rounded-lg bg-emerald-50 p-3 text-emerald-800" role="status">A new link is on its way. The earlier one no longer works.</p>
              : <><Button className="w-full" loading={resend.isPending} onClick={() => resend.mutate()}>Send me a new link</Button><ErrorBox error={resend.error} /></>
          ) : (
            <p className="text-slate-500">{signedIn ? 'Your address may already be confirmed.' : 'Sign in and we will offer to send you a new link.'}</p>
          )}
        </div>
      )}
    </Shell>
  );
}
