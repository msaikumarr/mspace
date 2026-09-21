import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Background jobs so long-running work (document processing, embeddings, AI summarisation) never blocks an API request.
 *
 * - With REDIS_URL set (and not in tests) jobs go through a BullMQ queue: they survive restarts, are retried with
 *   backoff, and any instance can pick them up. Delivery is at-least-once, so handlers must be idempotent.
 * - Without Redis an in-process queue with the same interface is used.
 *
 * `enqueue` resolves once the job is accepted, not when it finishes. Handlers that need to tell clients
 * (e.g. over Socket.IO) do so themselves when they complete.
 */
/** Which try this is, so a handler can tell a retry is still coming from "this was the last attempt" and record a final failure. */
export interface JobContext { attempt: number; maxAttempts: number }
type Handler<T> = (payload: T, ctx: JobContext) => Promise<void>;

export interface JobQueue {
  register<T>(name: string, handler: Handler<T>): void;
  enqueue<T>(name: string, payload: T): Promise<void>;
  /** Begins processing (no-op for the in-process queue, which pumps on demand). */
  start(): void;
  /** Resolves when nothing is waiting, running or delayed (used by tests). */
  drain(): Promise<void>;
  close(): Promise<void>;
}

const MAX_ATTEMPTS = 2;

export class MemoryQueue implements JobQueue {
  private handlers = new Map<string, Handler<any>>();
  private pending: { name: string; payload: unknown; attempts: number }[] = [];
  private running = 0;
  constructor(private concurrency = 2) {}

  register<T>(name: string, handler: Handler<T>) {
    this.handlers.set(name, handler);
  }

  async enqueue<T>(name: string, payload: T) {
    this.pending.push({ name, payload, attempts: 0 });
    setImmediate(() => this.pump());
  }

  start() {}

  private pump() {
    while (this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.running++;
      const h = this.handlers.get(job.name);
      (h ? h(job.payload, { attempt: job.attempts + 1, maxAttempts: MAX_ATTEMPTS }) : Promise.reject(new Error(`No handler for job ${job.name}`)))
        .catch((err) => {
          job.attempts++;
          logger.error('job failed', { job: job.name, attempt: job.attempts, err: String(err?.message || err) });
          if (job.attempts < MAX_ATTEMPTS) this.pending.push(job);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  async drain() {
    while (this.running > 0 || this.pending.length > 0) await new Promise((r) => setTimeout(r, 20));
  }

  async close() {}
}

/** BullMQ takes plain options rather than our ioredis instance, which avoids two ioredis versions clashing. */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export class RedisQueue implements JobQueue {
  private handlers = new Map<string, Handler<any>>();
  private queue: Queue;
  private worker?: Worker;

  constructor(private url: string, private name = 'm-space-jobs', private concurrency = 2, backoffMs = 1000) {
    this.queue = new Queue(name, {
      connection: redisConnection(url),
      defaultJobOptions: {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: backoffMs },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
    this.queue.on('error', (e) => logger.warn('queue error', { err: e.message }));
  }

  register<T>(name: string, handler: Handler<T>) {
    this.handlers.set(name, handler);
  }

  async enqueue<T>(name: string, payload: T) {
    await this.queue.add(name, payload);
  }

  start() {
    if (this.worker) return;
    this.worker = new Worker(
      this.name,
      async (job) => {
        const h = this.handlers.get(job.name);
        if (!h) throw new Error(`No handler for job ${job.name}`);
        await h(job.data, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? MAX_ATTEMPTS });
      },
      { connection: redisConnection(this.url), concurrency: this.concurrency },
    );
    this.worker.on('failed', (job, err) => logger.error('job failed', { job: job?.name, attempt: job?.attemptsMade, err: err.message }));
    this.worker.on('error', (e) => logger.warn('worker error', { err: e.message }));
  }

  async drain() {
    for (;;) {
      const c = await this.queue.getJobCounts('waiting', 'active', 'delayed');
      if (c.waiting + c.active + c.delayed === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
  }
}

export const jobs: JobQueue = env.REDIS_URL && env.NODE_ENV !== 'test' ? new RedisQueue(env.REDIS_URL) : new MemoryQueue();

export const registerJob = <T>(name: string, handler: Handler<T>) => jobs.register(name, handler);
export const enqueue = <T>(name: string, payload: T) => jobs.enqueue(name, payload);
export const startQueue = () => jobs.start();
export const stopQueue = () => jobs.close();
export const drain = () => jobs.drain();
