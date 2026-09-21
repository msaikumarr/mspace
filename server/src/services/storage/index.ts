import fs from 'fs/promises';
import path from 'path';
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { notFound } from '../../utils/errors';

/**
 * File storage for uploads (documents, chat attachments). Callers hold an opaque `ref` (the value saved in the
 * database) and never touch the disk or a bucket directly, so the driver can change without touching them.
 *
 * Keys look like `<workspaceId>/docs/<id>.pdf`. Records written before this abstraction hold absolute local
 * paths; the local driver still reads and deletes those.
 */
export interface Storage {
  /** Saves `body` under `key` and returns the ref to store in the database. */
  put(key: string, body: Buffer, contentType?: string): Promise<string>;
  /** Throws StorageNotFound when the object is missing. */
  get(ref: string): Promise<Buffer>;
  /** Idempotent: removing something that is already gone is not an error. */
  remove(ref: string): Promise<void>;
  /** Removes everything whose key starts with `prefix` (used when a workspace is deleted). */
  removePrefix(prefix: string): Promise<void>;
}

export class StorageNotFound extends Error {
  constructor(ref: string) {
    super(`Stored file not found: ${ref}`);
  }
}

export class LocalStorage implements Storage {
  private base: string;
  constructor(dir: string) {
    this.base = path.resolve(dir);
  }

  private resolve(ref: string) {
    if (path.isAbsolute(ref)) return ref; // legacy record written before keys existed
    const p = path.resolve(this.base, ref);
    if (p !== this.base && !p.startsWith(this.base + path.sep)) throw new Error('Storage key escapes the storage directory');
    return p;
  }

  async put(key: string, body: Buffer) {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    return key;
  }

  async get(ref: string) {
    try {
      return await fs.readFile(this.resolve(ref));
    } catch (e: any) {
      if (e?.code === 'ENOENT') throw new StorageNotFound(ref);
      throw e;
    }
  }

  async remove(ref: string) {
    await fs.rm(this.resolve(ref), { force: true });
  }

  async removePrefix(prefix: string) {
    await fs.rm(this.resolve(prefix), { recursive: true, force: true });
  }
}

export interface S3Options {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  /** Objects listed per request when deleting a prefix (S3 caps this at 1000). Lowered in tests to exercise paging. */
  listPageSize?: number;
}

export class S3Storage implements Storage {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private pageSize?: number;

  constructor(o: S3Options) {
    this.bucket = o.bucket;
    this.pageSize = o.listPageSize;
    this.prefix = o.prefix ? o.prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
    const cfg: S3ClientConfig = {
      region: o.region || 'us-east-1',
      endpoint: o.endpoint || undefined,
      forcePathStyle: o.forcePathStyle,
      // Only add checksums when the operation requires them: S3-compatible servers (MinIO, R2, ...) lag behind AWS here.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    // Without explicit keys the SDK falls back to its default chain (env vars, shared config, instance/task role).
    if (o.accessKeyId && o.secretAccessKey) cfg.credentials = { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey };
    this.client = new S3Client(cfg);
  }

  private k(ref: string) {
    return this.prefix + ref.replace(/^\/+/, '');
  }

  async put(key: string, body: Buffer, contentType?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: body, ContentType: contentType }));
    return key;
  }

  async get(ref: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(ref) }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) throw new StorageNotFound(ref);
      throw e;
    }
  }

  async remove(ref: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(ref) }));
  }

  async removePrefix(prefix: string) {
    const Prefix = this.k(prefix.endsWith('/') ? prefix : prefix + '/');
    let ContinuationToken: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix, ContinuationToken, MaxKeys: this.pageSize }));
      const Objects = (page.Contents || []).map((o) => ({ Key: o.Key! }));
      if (Objects.length) {
        const r = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects, Quiet: true } }));
        if (r.Errors?.length) throw new Error(`Failed to delete ${r.Errors.length} objects: ${r.Errors[0].Message}`);
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }

  destroy() {
    this.client.destroy();
  }
}

const driver = env.STORAGE_DRIVER ?? (env.S3_BUCKET ? 's3' : 'local');

export const storage: Storage =
  driver === 's3'
    ? new S3Storage({
        bucket: env.S3_BUCKET!, region: env.S3_REGION, endpoint: env.S3_ENDPOINT, accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY, forcePathStyle: env.S3_FORCE_PATH_STYLE, prefix: env.S3_PREFIX,
      })
    : new LocalStorage(env.STORAGE_DIR);

/** Reads a stored file, turning "missing" into the API's standard 404. */
export async function readOr404(ref: string) {
  try {
    return await storage.get(ref);
  } catch (e) {
    if (e instanceof StorageNotFound) throw notFound('File');
    throw e;
  }
}
