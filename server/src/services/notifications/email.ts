import nodemailer, { type Transporter } from 'nodemailer';
import { emailConfigured, mailSettings } from '../../config/mail';
import { logger } from '../../utils/logger';

let cached: { url: string; transport: Transporter } | null = null;

function transport(url: string) {
  if (cached?.url !== url) {
    // Timeouts keep a slow or unreachable mail server from hanging a request that is waiting on us.
    cached = { url, transport: nodemailer.createTransport({ url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 }) };
  }
  return cached.transport;
}

/**
 * Sends an email over SMTP (`SMTP_URL`, e.g. smtp://user:pass@host:587 or smtps://user:pass@host:465). Works with any
 * provider that offers SMTP: SES, SendGrid, Postmark, Mailgun, Resend, Gmail app passwords, or Mailpit for development.
 *
 * Never throws: an outage must not break sign-up or password reset, and every email this app sends can be requested
 * again. Without SMTP_URL the message is only logged, so development works without a mail server.
 */
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<{ sent: boolean }> {
  const cfg = mailSettings();
  if (!emailConfigured()) {
    logger.info('email (not sent - SMTP_URL is not set)', { to, subject, text });
    return { sent: false };
  }
  try {
    await transport(cfg.smtpUrl!).sendMail({ from: cfg.from, to, subject, text, html });
    logger.info('email sent', { to, subject });
    return { sent: true };
  } catch (e) {
    // the body is not logged here: it holds a one-time link
    logger.error('email could not be sent', { to, subject, err: String(e) });
    return { sent: false };
  }
}

/** Closes pooled connections (used when tests swap servers). */
export function closeMailTransport() {
  cached?.transport.close();
  cached = null;
}
