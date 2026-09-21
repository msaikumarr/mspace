import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import { setup, teardown, app, signup, addMember, upgrade, type Actor } from './helpers';
import { createFakeTranscriber, FAKE_KEY, DEFAULT_TEXT } from './support/fakeTranscriptionServer';
import { configureTranscription, sniffAudio, AUDIO_FORMATS } from '../src/services/ai/transcribe';
import { storage, StorageNotFound } from '../src/services/storage';
import { drain, jobs } from '../src/jobs/queue';
import { Meeting } from '../src/models/Knowledge';
import { Usage } from '../src/models/Misc';
import { PLANS } from '../src/config/plans';

let fake: Awaited<ReturnType<typeof createFakeTranscriber>>;
beforeAll(async () => { await setup(); fake = await createFakeTranscriber(); });
afterAll(async () => { await fake.close(); await teardown(); });
beforeEach(() => {
  fake.reset();
  configureTranscription({ apiKey: FAKE_KEY, baseUrl: fake.baseUrl, explicitBase: true, model: 'whisper-test', credits: 5 });
});
afterEach(() => configureTranscription());

const wav = (extra = 64) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(extra, 7)]);
const upload = (a: Actor, file: Buffer | null, name = 'standup.wav', fields: Record<string, string> = { title: 'Weekly standup' }) => {
  const r = request(app).post('/api/meetings/audio').set(a.wsHeader());
  for (const [k, v] of Object.entries(fields)) r.field(k, v);
  if (file) r.attach('audio', file, name);
  return r;
};
const pro = async (name: string) => { const a = await signup(name); await upgrade(a, 'pro'); return a; };
const credits = async (a: Actor) => (await a.get('/billing')).body.data.usage.aiRequests.used as number;
const meeting = async (a: Actor, id: string) => (await a.get(`/meetings/${id}`)).body.data;
const audioKey = (a: Actor, id: string, ext = 'wav') => `${a.workspaceId}/audio/${id}.${ext}`;
const gone = (key: string) => storage.get(key).then(() => false, (e) => e instanceof StorageNotFound);

describe('capabilities', () => {
  it('reports whether recordings can be uploaded, and the limits', async () => {
    const a = await pro('Caps');
    const on = (await a.get('/meetings/capabilities')).body.data.audio;
    expect(on).toMatchObject({ enabled: true, maxMb: 1 });
    expect(on.formats).toEqual([...AUDIO_FORMATS]);
    configureTranscription({ apiKey: undefined, explicitBase: false });
    expect((await a.get('/meetings/capabilities')).body.data.audio.enabled).toBe(false);
  });

  it('is also on for a self-hosted server that needs no key', async () => {
    configureTranscription({ apiKey: undefined, explicitBase: true });
    expect((await (await pro('Selfhost')).get('/meetings/capabilities')).body.data.audio.enabled).toBe(true);
  });
});

describe('recording upload', () => {
  it('transcribes a recording, analyses it like a pasted transcript, charges credits and discards the audio', async () => {
    const a = await pro('Happy');
    const bytes = wav();
    const before = await credits(a);
    const r = await upload(a, bytes, 'standup.wav', { title: 'Weekly standup' });
    expect(r.status).toBe(202);
    expect(r.body.data.status).toBe('TRANSCRIBING');
    expect(r.body.data.source).toBe('audio');
    expect(JSON.stringify(r.body)).not.toMatch(/audio\/|"ref"/); // the storage location is internal
    await drain();

    const m = await meeting(a, r.body.data.id);
    expect(m.status).toBe('READY');
    expect(m.transcript).toBe(DEFAULT_TEXT);
    expect(m.summary).toBeTruthy();
    // Speech-to-text has no speaker labels, so what was said aloud becomes unassigned action items for the reviewer to assign.
    expect(m.actionItems.map((i: { title: string }) => i.title)).toEqual(
      expect.arrayContaining(['Write the release notes by Friday', 'Send the invoice to finance', 'Schedule a follow-up next week']),
    );
    expect(m.actionItems.every((i: { assigneeName?: string }) => !i.assigneeName)).toBe(true);
    expect(m.audio).toEqual({ name: 'standup.wav', size: bytes.length });
    expect(await credits(a)).toBe(before + 5);
    expect(await gone(audioKey(a, r.body.data.id))).toBe(true); // recordings are not kept once transcribed

    // exactly what the provider's API expects
    expect(fake.received).toHaveLength(1);
    const got = fake.received[0];
    expect(got.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(got.model).toBe('whisper-test');
    expect(got.filename).toBe('standup.wav');
    expect(got.contentType).toBe('audio/wav');
    expect(Buffer.compare(got.bytes, bytes)).toBe(0); // the stored bytes came back unchanged
  });

  it('sends no Authorization header to a keyless self-hosted server', async () => {
    const open = await createFakeTranscriber(0, { key: null });
    try {
      configureTranscription({ apiKey: undefined, baseUrl: open.baseUrl, explicitBase: true });
      const a = await pro('Keyless');
      expect((await upload(a, wav())).status).toBe(202);
      await drain();
      expect(open.received).toHaveLength(1);
      expect(open.received[0].authorization).toBeUndefined();
    } finally {
      await open.close();
    }
  });

  it('works for every supported format', async () => {
    const a = await pro('Formats');
    const samples: Record<string, Buffer> = {
      mp3: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]), mpeg: Buffer.from([0xff, 0xfb, 0x90, 0, 0, 0, 0, 0]), mpga: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40)]),
      wav: wav(), ogg: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)]), flac: Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(40)]),
      m4a: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(40)]), mp4: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(40)]),
      webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40)]),
    };
    for (const ext of AUDIO_FORMATS) {
      const r = await upload(a, samples[ext], `talk.${ext}`, { title: `as ${ext}` });
      expect(r.status, ext).toBe(202);
    }
    await drain();
  });

  it('can be attached to a project', async () => {
    const a = await pro('Proj');
    const p = (await a.post('/projects', { name: 'Apollo' })).body.data;
    const r = await upload(a, wav(), 'a.wav', { title: 'Kickoff', projectId: p.id });
    expect(r.status).toBe(202);
    expect(String(r.body.data.projectId)).toBe(p.id);
    expect((await upload(a, wav(), 'a.wav', { title: 'x', projectId: '64b0000000000000000000aa' })).status).toBe(404);
    await drain();
  });
});

describe('validation, before anything is charged or stored', () => {
  async function rejected(a: Actor, res: request.Test, status: number, code?: string) {
    const before = await credits(a);
    const r = await res;
    expect(r.status).toBe(status);
    if (code) expect(r.body.error.code).toBe(code);
    expect(await credits(a)).toBe(before);
    expect(await Meeting.countDocuments({ workspaceId: a.workspaceId })).toBe(0);
    expect(fake.received).toHaveLength(0);
  }

  it('rejects a missing file, a wrong type, empty content, a renamed non-audio file and a missing title', async () => {
    const a = await pro('Invalid');
    await rejected(a, upload(a, null), 400, 'NO_FILE');
    await rejected(a, upload(a, wav(), 'notes.txt'), 400, 'UNSUPPORTED_TYPE');
    await rejected(a, upload(a, Buffer.alloc(0), 'empty.wav'), 400, 'EMPTY_FILE');
    await rejected(a, upload(a, Buffer.from('this is plain text, not audio at all'), 'sneaky.mp3'), 400, 'CONTENT_MISMATCH');
    await rejected(a, upload(a, wav(), 'a.wav', {}), 422, 'VALIDATION_ERROR');
    await rejected(a, upload(a, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]), 'video.wav'), 400, 'CONTENT_MISMATCH');
  });

  it('rejects a recording over the size limit', async () => {
    const a = await pro('Big');
    await rejected(a, upload(a, Buffer.concat([wav(), Buffer.alloc(1024 * 1024 + 1)]), 'big.wav'), 413, 'UPLOAD_ERROR');
  });

  it('says so plainly when transcription is not configured', async () => {
    const a = await pro('Unconfigured');
    configureTranscription({ apiKey: undefined, explicitBase: false });
    await rejected(a, upload(a, wav()), 503, 'TRANSCRIPTION_NOT_CONFIGURED');
  });

  it('keeps recordings behind the Pro plan and the member role', async () => {
    const free = await signup('Free');
    await rejected(free, upload(free, wav()), 403, 'UPGRADE_REQUIRED');
    const owner = await pro('Boss');
    const viewer = await addMember(owner, 'viewer', 'Watcher');
    expect((await upload(viewer, wav())).status).toBe(403);
    const member = await addMember(owner, 'member', 'Worker');
    expect((await upload(member, wav())).status).toBe(202);
    await drain();
  });

  it('refuses when the monthly AI allowance cannot cover the recording', async () => {
    const a = await pro('Broke');
    await Usage.create({ workspaceId: a.workspaceId, userId: a.id, requestType: 'chat', credits: PLANS.pro.aiRequestsPerMonth - 4 });
    await rejected(a, upload(a, wav()), 429, 'AI_LIMIT_EXCEEDED'); // needs 5, only 4 left
    await Usage.deleteMany({ workspaceId: a.workspaceId });
    expect((await upload(a, wav())).status).toBe(202);
    await drain();
  });
});

describe('when the transcription service misbehaves', () => {
  async function failed(a: Actor, id: string) {
    const m = await meeting(a, id);
    expect(m.status).toBe('FAILED');
    expect(await credits(a)).toBe(0); // a recording that could not be transcribed costs nothing
    expect(await gone(audioKey(a, id))).toBe(true); // and is not kept
    expect(await Usage.countDocuments({ workspaceId: a.workspaceId })).toBe(0);
    return m as { error: string; transcript: string };
  }

  it('retries a temporary error once and then succeeds', async () => {
    const a = await pro('Flaky');
    fake.next({ status: 503, error: 'overloaded' });
    const r = await upload(a, wav());
    await drain();
    expect(fake.received).toHaveLength(2);
    expect((await meeting(a, r.body.data.id)).status).toBe('READY');
    expect(await credits(a)).toBe(5); // charged once, not per attempt
  });

  it('gives up after the last attempt and says why, instead of staying "Transcribing…" forever', async () => {
    const a = await pro('Down');
    fake.next({ status: 500 }, { status: 502 });
    const r = await upload(a, wav());
    await drain();
    expect(fake.received).toHaveLength(2);
    const m = await failed(a, r.body.data.id);
    expect(m.error).toMatch(/busy or unavailable/);
  });

  it('does not retry a rejected API key, and points the administrator at the setting', async () => {
    const a = await pro('BadKey');
    configureTranscription({ apiKey: 'wrong-key', baseUrl: fake.baseUrl, explicitBase: true });
    const r = await upload(a, wav());
    await drain();
    const m = await failed(a, r.body.data.id);
    expect(m.error).toMatch(/TRANSCRIBE_API_KEY/);
    expect(m.error).not.toContain('wrong-key');
  });

  it('does not retry audio the service rejects, and passes on its reason', async () => {
    const a = await pro('Corrupt');
    fake.next({ status: 400, error: { message: 'Audio file might be corrupted or unsupported' } });
    const r = await upload(a, wav());
    await drain();
    expect(fake.received).toHaveLength(1);
    expect((await failed(a, r.body.data.id)).error).toMatch(/corrupted or unsupported/);
  });

  it('reports silence rather than analysing an empty transcript', async () => {
    const a = await pro('Silent');
    fake.next({ text: '   ' });
    const r = await upload(a, wav());
    await drain();
    expect((await failed(a, r.body.data.id)).error).toMatch(/No speech/);
  });

  it('retries and then fails cleanly when the service cannot be reached at all', async () => {
    const a = await pro('Offline');
    configureTranscription({ apiKey: FAKE_KEY, baseUrl: 'http://127.0.0.1:1/v1', explicitBase: true });
    const r = await upload(a, wav());
    await drain();
    expect((await failed(a, r.body.data.id)).error).toMatch(/Could not reach/);
  });

  it('a failed recording does not leave the meeting unusable: approving is refused, deleting works', async () => {
    const a = await pro('Cleanup');
    fake.next({ status: 400, error: 'bad' });
    const r = await upload(a, wav());
    await drain();
    const p = (await a.post('/projects', { name: 'P' })).body.data;
    expect((await a.post(`/meetings/${r.body.data.id}/approve`, { projectId: p.id, items: [{ index: 0 }] })).status).toBe(400);
    expect((await a.del(`/meetings/${r.body.data.id}`)).status).toBe(200);
    expect((await a.get(`/meetings/${r.body.data.id}`)).status).toBe(404);
  });
});

describe('when the job queue is down at upload time', () => {
  it('fails the meeting with a clear message, refunds the credits and discards the recording', async () => {
    const a = await pro('QueueDown');
    const spy = vi.spyOn(jobs, 'enqueue').mockRejectedValueOnce(new Error('redis is down'));
    try {
      const r = await upload(a, wav());
      expect(r.status).toBe(202);
      expect(r.body.data.status).toBe('FAILED');
      expect(r.body.data.error).toMatch(/could not be queued/);
      expect(await credits(a)).toBe(0);
      expect(await Usage.countDocuments({ workspaceId: a.workspaceId })).toBe(0);
      expect(await gone(audioKey(a, r.body.data.id))).toBe(true);
      expect(fake.received).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('file handling', () => {
  it('removes the stored recording when the meeting is deleted mid-transcription', async () => {
    const a = await pro('Mid');
    fake.next({ status: 503 }); // keeps the first attempt failing so the recording is still stored
    const r = await upload(a, wav());
    const id = r.body.data.id;
    const del = await a.del(`/meetings/${id}`);
    expect(del.status).toBe(200);
    await drain();
    expect(await gone(audioKey(a, id))).toBe(true);
  });

  it('keeps the stored recording out of the meeting list', async () => {
    const a = await pro('List');
    await upload(a, wav());
    await drain();
    expect(JSON.stringify((await a.get('/meetings')).body)).not.toMatch(/\/audio\//);
  });
});

describe('sniffAudio', () => {
  it('accepts real headers and rejects a mismatched extension', () => {
    expect(sniffAudio(wav(), 'wav')).toBe(true);
    expect(sniffAudio(wav(), 'mp3')).toBe(false);
    expect(sniffAudio(Buffer.from('OggS....'), 'ogg')).toBe(true);
    expect(sniffAudio(Buffer.from('OggS....'), 'flac')).toBe(false);
    expect(sniffAudio(Buffer.from('%PDF-1.7'), 'wav')).toBe(false);
    expect(sniffAudio(Buffer.from([0xff, 0xfb, 0, 0]), 'mp3')).toBe(true);
    expect(sniffAudio(Buffer.from([0xff, 0x10, 0, 0]), 'mp3')).toBe(false); // 0xFF but not an MPEG frame sync
    expect(sniffAudio(Buffer.alloc(2), 'wav')).toBe(false); // too short to have a header
    expect(sniffAudio(wav(), 'exe')).toBe(false);
  });
});
