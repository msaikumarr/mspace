import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

/** Small cache abstraction: Redis when REDIS_URL is set, otherwise an in-process TTL map. */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec: number): Promise<void>;
  del(prefix: string): Promise<void>;
}

class MemoryCache implements Cache {
  private m = new Map<string, { v: string; exp: number }>();
  async get<T>(key: string) {
    const e = this.m.get(key);
    if (!e || e.exp < Date.now()) return null;
    return JSON.parse(e.v) as T;
  }
  async set(key: string, value: unknown, ttl: number) {
    this.m.set(key, { v: JSON.stringify(value), exp: Date.now() + ttl * 1000 });
  }
  async del(prefix: string) {
    for (const k of this.m.keys()) if (k.startsWith(prefix)) this.m.delete(k);
  }
}

class RedisCache implements Cache {
  constructor(private r: Redis) {}
  async get<T>(key: string) {
    const v = await this.r.get(key);
    return v ? (JSON.parse(v) as T) : null;
  }
  async set(key: string, value: unknown, ttl: number) {
    await this.r.set(key, JSON.stringify(value), 'EX', ttl);
  }
  async del(prefix: string) {
    const keys = await this.r.keys(`${prefix}*`);
    if (keys.length) await this.r.del(...keys);
  }
}

export let redis: Redis | null = null;
if (env.REDIS_URL && env.NODE_ENV !== 'test') {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  redis.on('error', (e) => logger.warn('redis error', { err: e.message }));
}
export const cache: Cache = redis ? new RedisCache(redis) : new MemoryCache();
