import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createSmtpCapture } from './support/smtpCapture';
import { configureMail } from '../src/config/mail';
import { sendEmail, closeMailTransport } from '../src/services/notifications/email';
import { verifyEmailMessage, resetPasswordMessage, inviteMessage } from '../src/services/notifications/mailTemplates';

let smtp: Awaited<ReturnType<typeof createSmtpCapture>>;
let authed: Awaited<ReturnType<typeof createSmtpCapture>>;

beforeAll(async () => {
  smtp = await createSmtpCapture();
  authed = await createSmtpCapture(0, { user: 'mailer', pass: 's3cret/pass word' });
});
afterAll(async () => { await smtp.close(); await authed.close(); });
afterEach(() => { configureMail(); closeMailTransport(); smtp.clear(); authed.clear(); });

describe('sending over SMTP', () => {
  it('delivers a message with the configured sender, recipient, subject and both text and HTML bodies', async () => {
    configureMail({ smtpUrl: smtp.url, from: 'M-Space <no-reply@mspace.test>' });
    const m = verifyEmailMessage('Ada Lovelace', 'https://app.test/verify-email?token=abc');
    expect(await sendEmail('ada@example.test', m.subject, m.text, m.html)).toEqual({ sent: true });

    const got = await smtp.latest('ada@example.test');
    expect(got.from).toContain('no-reply@mspace.test');
    expect(got.from).toContain('M-Space');
    expect(got.subject).toBe(m.subject);
    expect(got.text).toContain('Hi Ada,');
    expect(got.links).toContain('https://app.test/verify-email?token=abc');
    expect(got.html).toContain('href="https://app.test/verify-email?token=abc"');
  });

  it('logs in with the credentials in the URL, including ones that need percent-encoding', async () => {
    configureMail({ smtpUrl: authed.url });
    expect(await sendEmail('a@example.test', 'hi', 'body')).toEqual({ sent: true });
    expect((await authed.latest('a@example.test')).authUser).toBe('mailer');
  });

  it('reports failure, without throwing, when the login is wrong', async () => {
    configureMail({ smtpUrl: `smtp://mailer:wrong@127.0.0.1:${authed.port}` });
    expect(await sendEmail('a@example.test', 'hi', 'body')).toEqual({ sent: false });
    expect(authed.messages).toHaveLength(0);
  });

  it('reports failure, without throwing, when the server cannot be reached', async () => {
    configureMail({ smtpUrl: 'smtp://127.0.0.1:1' });
    expect(await sendEmail('a@example.test', 'hi', 'body')).toEqual({ sent: false });
  });

  it('reports failure, without throwing, when the server rejects the message', async () => {
    configureMail({ smtpUrl: smtp.url });
    smtp.rejectNext();
    expect(await sendEmail('a@example.test', 'hi', 'body')).toEqual({ sent: false });
    expect(await sendEmail('b@example.test', 'hi', 'body')).toEqual({ sent: true }); // and the next one is fine
  });

  it('only logs when no SMTP server is configured', async () => {
    configureMail({ smtpUrl: undefined });
    expect(await sendEmail('a@example.test', 'hi', 'body')).toEqual({ sent: false });
    expect(smtp.messages).toHaveLength(0);
  });

  it('switches servers when the configuration changes', async () => {
    configureMail({ smtpUrl: smtp.url });
    await sendEmail('one@example.test', 'first', 'x');
    configureMail({ smtpUrl: authed.url });
    await sendEmail('two@example.test', 'second', 'x');
    expect(smtp.to('one@example.test')).toHaveLength(1);
    expect(authed.to('two@example.test')).toHaveLength(1);
    expect(smtp.to('two@example.test')).toHaveLength(0);
  });
});

describe('message templates', () => {
  it('put the link in both bodies and escape user-supplied text in the HTML one', () => {
    const inv = inviteMessage('<b>Mallory</b>', 'Acme & "Co"', 'admin', 'https://app.test/login');
    expect(inv.subject).toContain('<b>Mallory</b>'); // a subject is plain text
    expect(inv.html).not.toContain('<b>Mallory</b>');
    expect(inv.html).toContain('&#60;b&#62;Mallory');
    expect(inv.html).toContain('Acme &#38; &#34;Co&#34;');
    expect(inv.text).toContain('https://app.test/login');

    const reset = resetPasswordMessage('https://app.test/reset-password?token=t');
    expect(reset.text).toContain('https://app.test/reset-password?token=t');
    expect(reset.html).toContain('href="https://app.test/reset-password?token=t"');
  });

  it('stays sensible for an odd name', () => {
    expect(verifyEmailMessage('', 'https://x.test/v').text).toContain('Hi there,');
    expect(verifyEmailMessage('Cher', 'https://x.test/v').text).toContain('Hi Cher,');
  });
});
