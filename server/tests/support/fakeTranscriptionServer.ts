import http from 'http';
import { Readable } from 'stream';
import type { AddressInfo } from 'net';

/**
 * A stand-in for an OpenAI-compatible speech-to-text server (`POST /v1/audio/transcriptions`). It parses the real
 * multipart body and rejects what the real API rejects (bad key, missing file or model), so a malformed request from the
 * app fails a test instead of passing silently. Responses can be scripted per request with `next()`.
 */
export const FAKE_KEY = 'fake-transcribe-key';
// Shaped like real speech-to-text output: one run of prose, no speaker labels, no line breaks.
export const DEFAULT_TEXT = 'Okay everyone, thanks for joining. We decided to ship on 2030-03-01. I will write the release notes by Friday. Someone should send the invoice to finance. Let\'s schedule a follow-up next week.';

export type Scripted = { text?: string } | { status: number; error?: string | { message: string } };

export interface Received { authorization?: string; model?: string; responseFormat?: string; filename?: string; contentType?: string; bytes: Buffer }

export async function createFakeTranscriber(port = 0, opts: { key?: string | null; text?: string } = {}) {
  const key = opts.key === undefined ? FAKE_KEY : opts.key; // null: accept anonymous requests (a self-hosted server)
  const received: Received[] = [];
  const script: Scripted[] = [];
  const defaultText = opts.text ?? DEFAULT_TEXT;

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true }); // for readiness probes
    if (req.method !== 'POST' || req.url !== '/v1/audio/transcriptions') return send(404, { error: { message: 'not found' } });
    if (key && req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { message: 'Incorrect API key provided' } });

    let form: FormData;
    try {
      form = await new Request('http://fake/', { method: 'POST', headers: { 'content-type': String(req.headers['content-type'] || '') }, body: Readable.toWeb(req) as unknown as ReadableStream, duplex: 'half' } as RequestInit).formData();
    } catch {
      return send(400, { error: { message: 'could not parse multipart body' } });
    }
    const file = form.get('file');
    if (!(file instanceof File)) return send(400, { error: { message: "you must provide a 'file' parameter" } });
    if (!form.get('model')) return send(400, { error: { message: "you must provide a 'model' parameter" } });
    received.push({
      authorization: req.headers.authorization, model: String(form.get('model')), responseFormat: String(form.get('response_format') ?? ''),
      filename: file.name, contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()),
    });

    // Magic filenames, so browser tests (which cannot script responses) can trigger the failure paths.
    if (file.name.includes('corrupt')) return send(400, { error: { message: 'Audio file might be corrupted or unsupported' } });
    if (file.name.includes('silent')) return send(200, { text: '' });
    const next = script.shift() ?? { text: defaultText };
    if ('status' in next) return send(next.status, { error: next.error ?? { message: 'scripted failure' } });
    return send(200, { text: next.text });
  });

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    /** Value for TRANSCRIBE_BASE_URL. */
    baseUrl: `${base}/v1`,
    received,
    /** Queue up the responses to give to the next requests, in order; after that it answers with the default text. */
    next: (...s: Scripted[]) => { script.push(...s); },
    reset: () => { received.length = 0; script.length = 0; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// `npx tsx tests/support/fakeTranscriptionServer.ts` runs it standalone (the browser tests do this)
if (require.main === module) {
  createFakeTranscriber(Number(process.env.PORT || 4400), { text: process.env.TRANSCRIPT_TEXT }).then((s) => console.log(`fake transcription server on ${s.baseUrl}`));
}
