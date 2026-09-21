import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { LocalStorage, S3Storage, StorageNotFound, type Storage } from '../src/services/storage';

const S3 = process.env.TEST_S3_ENDPOINT
  ? {
      endpoint: process.env.TEST_S3_ENDPOINT,
      bucket: process.env.TEST_S3_BUCKET || 'm-space-test',
      accessKeyId: process.env.TEST_S3_ACCESS_KEY || 'minioadmin',
      secretAccessKey: process.env.TEST_S3_SECRET_KEY || 'minioadmin',
    }
  : null;

const bytes = (s: string) => Buffer.from(s);

/** Behaviour every storage driver must share. `make` returns a fresh, empty namespace each time. */
function contract(make: () => Storage) {
  it('stores and returns exact bytes, including binary data', async () => {
    const s = make();
    const bin = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 10, 13]);
    const ref = await s.put('ws1/docs/a.bin', bin, 'application/octet-stream');
    expect(Buffer.compare(await s.get(ref), bin)).toBe(0);
  });

  it('throws StorageNotFound for a missing file', async () => {
    const s = make();
    await expect(s.get('ws1/docs/nope.txt')).rejects.toBeInstanceOf(StorageNotFound);
  });

  it('overwrites an existing key', async () => {
    const s = make();
    await s.put('ws1/a.txt', bytes('one'));
    await s.put('ws1/a.txt', bytes('two'));
    expect((await s.get('ws1/a.txt')).toString()).toBe('two');
  });

  it('removes a file, and removing it again (or a missing one) is not an error', async () => {
    const s = make();
    const ref = await s.put('ws1/docs/x.txt', bytes('x'));
    await s.remove(ref);
    await expect(s.get(ref)).rejects.toBeInstanceOf(StorageNotFound);
    await expect(s.remove(ref)).resolves.toBeUndefined();
    await expect(s.remove('ws1/docs/never-existed.txt')).resolves.toBeUndefined();
  });

  it('removePrefix deletes one workspace and leaves others (and look-alike prefixes) alone', async () => {
    const s = make();
    await s.put('ws1/docs/a.txt', bytes('a'));
    await s.put('ws1/chat/b.txt', bytes('b'));
    await s.put('ws10/docs/c.txt', bytes('c')); // shares the "ws1" characters but is a different workspace
    await s.put('ws2/docs/d.txt', bytes('d'));
    await s.removePrefix('ws1');
    await expect(s.get('ws1/docs/a.txt')).rejects.toBeInstanceOf(StorageNotFound);
    await expect(s.get('ws1/chat/b.txt')).rejects.toBeInstanceOf(StorageNotFound);
    expect((await s.get('ws10/docs/c.txt')).toString()).toBe('c');
    expect((await s.get('ws2/docs/d.txt')).toString()).toBe('d');
    await expect(s.removePrefix('ws-empty')).resolves.toBeUndefined();
  });
}

describe('local storage', () => {
  const dirs: string[] = [];
  const freshSync = () => {
    const d = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mspace-storage-'));
    dirs.push(d);
    return d;
  };
  const fresh = async () => freshSync();
  afterAll(() => Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))));

  contract(() => new LocalStorage(freshSync()));

  it('refuses keys that climb out of the storage directory', async () => {
    const s = new LocalStorage(await fresh());
    await expect(s.put('../escape.txt', bytes('x'))).rejects.toThrow(/escapes/);
    await expect(s.get('ws1/../../escape.txt')).rejects.toThrow(/escapes/);
  });

  it('still reads and deletes legacy records that hold an absolute path', async () => {
    const outside = await fresh();
    const legacy = path.join(outside, 'old-upload.txt');
    await fs.writeFile(legacy, 'from before storage keys');
    const s = new LocalStorage(await fresh());
    expect((await s.get(legacy)).toString()).toBe('from before storage keys');
    await s.remove(legacy);
    await expect(s.get(legacy)).rejects.toBeInstanceOf(StorageNotFound);
  });
});

describe.skipIf(!S3)('S3 storage (needs TEST_S3_ENDPOINT)', () => {
  const make = (extra: { prefix?: string; listPageSize?: number } = {}) =>
    new S3Storage({ ...S3!, forcePathStyle: true, prefix: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...extra });

  beforeAll(async () => {
    const c = new S3Client({
      region: 'us-east-1', endpoint: S3!.endpoint, forcePathStyle: true,
      credentials: { accessKeyId: S3!.accessKeyId, secretAccessKey: S3!.secretAccessKey },
    });
    await c.send(new CreateBucketCommand({ Bucket: S3!.bucket })).catch((e) => {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(e?.name)) throw e;
    });
    c.destroy();
  });

  contract(() => make());

  it('keeps two prefixes in one bucket isolated from each other', async () => {
    const a = make(), b = make();
    await a.put('ws1/f.txt', bytes('A'));
    await b.put('ws1/f.txt', bytes('B'));
    expect((await a.get('ws1/f.txt')).toString()).toBe('A');
    await a.removePrefix('ws1');
    expect((await b.get('ws1/f.txt')).toString()).toBe('B');
  });

  it('removePrefix pages through more objects than one listing returns', async () => {
    const s = make({ listPageSize: 2 });
    for (let i = 0; i < 7; i++) await s.put(`ws9/docs/${i}.txt`, bytes(String(i)));
    await s.removePrefix('ws9');
    for (let i = 0; i < 7; i++) await expect(s.get(`ws9/docs/${i}.txt`)).rejects.toBeInstanceOf(StorageNotFound);
  });
});
