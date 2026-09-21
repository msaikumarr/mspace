import { env } from './env';

/**
 * Whether the server can send email, and whether it therefore insists on verified addresses.
 *
 * REQUIRE_EMAIL_VERIFICATION=auto (the default) means "required exactly when SMTP is configured": a deployment with no way
 * to send a verification link must not lock people out of invitations, so it keeps the older, trusting behaviour.
 */
interface MailConfig { smtpUrl?: string; from: string; require: 'true' | 'false' | 'auto'; appUrl: string }

const fromEnv = (): MailConfig => ({
  smtpUrl: env.SMTP_URL || undefined,
  from: env.MAIL_FROM,
  require: env.REQUIRE_EMAIL_VERIFICATION,
  appUrl: env.CLIENT_URL.split(',')[0].trim().replace(/\/$/, ''),
});

let cfg = fromEnv();

/** Test hook: override configuration. Call with no argument to restore the environment. */
export function configureMail(o?: Partial<MailConfig>) {
  cfg = { ...fromEnv(), ...o };
}

export const mailSettings = () => cfg;
export const emailConfigured = () => !!cfg.smtpUrl;
export const verificationRequired = () => cfg.require === 'true' || (cfg.require === 'auto' && emailConfigured());
/** Public address of the web app, for links inside emails. */
export const appUrl = () => cfg.appUrl;
