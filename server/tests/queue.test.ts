import { describe, it, expect, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { MemoryQueue, RedisQueue, redisConnection, type JobQueue } from '../src/jobs/queue';

const REDIS = process.env.TEST_REDIS_URL;

/** Behaviour every queue implementation must share. */
function contract(make: () => JobQueue) {
  it('runs a job with its payload', async () => {
    const q = make();
    const seen: unknown[] = [];
    q.register('echo', async (p) => { seen.push(p); });
    q.start();
    await q.enqueue('echo', { n: 1 });
    await q.drain();
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ n: 1 }]);
    await q.close();
  });

  it('retries a failing job once, then gives up', async () => {
    const q = make();
    let calls = 0;
    q.register('flaky', async () => { calls++; if (calls === 1) throw new Error('boom'); });
    q.register('doomed', async () => { throw new Error('always'); });
    q.start();
    await q.enqueue('flaky', {});
    await waitFor(() => calls === 2);
    await q.drain();
    expect(calls).toBe(2);

    let doomed = 0;
    q.register('doomed', async () => { doomed++; throw new Error('always'); });
    await q.enqueue('doomed', {});
    await waitFor(() => doomed === 2);
    await q.drain();
    await new Promise((r) => setTimeout(r, 300));
    expect(doomed).toBe(2); // MAX_ATTEMPTS, not endless
    await q.close();
  });

  it('tells a handler which attempt it is on, so it can record a final failure instead of retrying', async () => {
    const q = make();
    const seen: { attempt: number; maxAttempts: number }[] = [];
    q.register('ctx', async (_p, ctx) => { seen.push({ ...ctx }); throw new Error('always fails'); });
    q.start();
    await q.enqueue('ctx', {});
    await waitFor(() => seen.length === 2);
    await q.drain();
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([{ attempt: 1, maxAttempts: 2 }, { attempt: 2, maxAttempts: 2 }]);
    await q.close();
  });

  it('never runs more than the configured concurrency', async () => {
    const q = make();
    let active = 0, peak = 0, done = 0;
    q.register('slow', async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 60));
      active--; done++;
    });
    q.start();
    for (let i = 0; i < 6; i++) await q.enqueue('slow', {});
    await waitFor(() => done === 6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    await q.close();
  });
}

async function waitFor(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('in-process queue', () => {
  contract(() => new MemoryQueue(2));
});

describe('redisConnection', () => {
  it('parses host, port, credentials, db and TLS from a URL', () => {
    expect(redisConnection('redis://localhost')).toMatchObject({ host: 'localhost', port: 6379 });
    expect(redisConnection('rediss://user:p%40ss@cache.example.com:6380/2')).toMatchObject({
      host: 'cache.example.com', port: 6380, username: 'user', password: 'p@ss', db: 2, tls: {},
    });
  });
});

describe.skipIf(!REDIS)('Redis queue (needs TEST_REDIS_URL)', () => {
  const names: string[] = [];
  const fresh = () => {
    const name = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    names.push(name);
    return name;
  };
  contract(() => new RedisQueue(REDIS!, fresh(), 2, 50));

  it('keeps jobs across a restart: work queued with no worker is done by a later one', async () => {
    const name = fresh();
    const producer = new RedisQueue(REDIS!, name, 2, 50);
    await producer.enqueue('report', { id: 42 });
    await producer.close(); // the "first process" goes away before anything ran

    const seen: unknown[] = [];
    const consumer = new RedisQueue(REDIS!, name, 2, 50); // the "restarted process"
    consumer.register('report', async (p) => { seen.push(p); });
    consumer.start();
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ id: 42 }]);
    await consumer.close();
  });

  it('shares work between two workers without running a job twice', async () => {
    const name = fresh();
    const ran: number[] = [];
    const a = new RedisQueue(REDIS!, name, 1, 50);
    const b = new RedisQueue(REDIS!, name, 1, 50);
    for (const q of [a, b]) q.register('once', async (p: { i: number }) => { ran.push(p.i); await new Promise((r) => setTimeout(r, 30)); });
    a.start(); b.start();
    for (let i = 0; i < 8; i++) await a.enqueue('once', { i });
    await waitFor(() => ran.length >= 8);
    await new Promise((r) => setTimeout(r, 200));
    expect([...ran].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await a.close(); await b.close();
  });

  afterAll(async () => {
    // remove every queue this file created so repeated runs against one Redis stay clean
    for (const n of names) {
      const q = new Queue(n, { connection: redisConnection(REDIS!) });
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    }
  });
});
