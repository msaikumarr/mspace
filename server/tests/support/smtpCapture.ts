import http from 'http';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import type { AddressInfo } from 'net';

/**
 * A real SMTP server that keeps what it receives, so tests exercise the actual wire protocol (connection, AUTH, headers,
 * multipart bodies) instead of a mock of the mail library. Run standalone (`npx tsx tests/support/smtpCapture.ts`) it also
 * serves the captured mail as JSON over HTTP, which the browser tests read to follow the links in real emails.
 */
export interface Captured {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** Every http(s) URL in the plain-text body. */
  links: string[];
  /** The SMTP login used, when the server requires one. */
  authUser?: string;
  receivedAt: number;
}

export async function createSmtpCapture(port = 0, opts: { user?: string; pass?: string } = {}) {
  const messages: Captured[] = [];
  const control = { rejectNext: false };

  const server = new SMTPServer({
    authOptional: !opts.user,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _session, cb) {
      if (!opts.user || (auth.username === opts.user && auth.password === opts.pass)) return cb(null, { user: auth.username });
      cb(new Error('Invalid login'));
    },
    onData(stream, session, cb) {
      simpleParser(stream)
        .then((m) => {
          if (control.rejectNext) {
            control.rejectNext = false;
            return cb(Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }));
          }
          const text = m.text || '';
          messages.push({
            from: m.from?.text || '',
            to: (Array.isArray(m.to) ? m.to : m.to ? [m.to] : []).flatMap((t) => t.value.map((v) => v.address || '')),
            subject: m.subject || '',
            text,
            html: typeof m.html === 'string' ? m.html : '',
            links: text.match(/https?:\/\/[^\s<>"]+/g) || [],
            authUser: (session.user as string | undefined) || undefined,
            receivedAt: Date.now(),
          });
          cb();
        })
        .catch(cb);
    },
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const smtpPort = (server.server.address() as AddressInfo).port;

  return {
    port: smtpPort,
    /** Value for SMTP_URL. */
    url: `smtp://${opts.user ? `${encodeURIComponent(opts.user)}:${encodeURIComponent(opts.pass || '')}@` : ''}127.0.0.1:${smtpPort}`,
    messages,
    /** Messages addressed to `address`, oldest first. */
    to: (address: string) => messages.filter((m) => m.to.some((t) => t.toLowerCase() === address.toLowerCase())),
    /** The most recent message to `address`, waiting briefly for it to arrive. */
    async latest(address: string, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.filter((m) => m.to.some((t) => t.toLowerCase() === address.toLowerCase()));
        if (found.length) return found[found.length - 1];
        if (Date.now() > end) throw new Error(`no email arrived for ${address}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    /** Make the next message fail with a permanent SMTP error, like a provider rejecting it. */
    rejectNext: () => { control.rejectNext = true; },
    clear: () => { messages.length = 0; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// `npx tsx tests/support/smtpCapture.ts` runs it standalone, with a JSON view of the inbox on HTTP_PORT (default PORT + 1)
if (require.main === module) {
  const smtpPort = Number(process.env.PORT || 4500);
  createSmtpCapture(smtpPort).then((s) => {
    http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
      const to = url.searchParams.get('to');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(to ? s.to(to) : s.messages));
    }).listen(Number(process.env.HTTP_PORT || smtpPort + 1), '127.0.0.1');
    console.log(`smtp capture on ${s.url}`);
  });
}
