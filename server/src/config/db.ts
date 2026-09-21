import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { env } from './env';
import { logger } from '../utils/logger';

// Every model serialises _id -> id and drops __v / secrets.
mongoose.set('toJSON', {
  versionKey: false,
  transform: (_doc, ret: Record<string, any>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.passwordHash;
    // `select: false` only hides a field from queries; a freshly created or explicitly loaded document still carries it,
    // and toJSON is what reaches API responses and socket broadcasts.
    delete ret.usageId;
    if (ret.audio) delete ret.audio.ref;
    if (ret.subscription) {
      delete ret.subscription.stripeCustomerId;
      delete ret.subscription.stripeSubscriptionId;
    }
    return ret;
  },
});

let memoryServer: { stop: () => Promise<boolean> } | null = null;

/** Connects to MONGODB_URI; in non-production without one, boots an embedded MongoDB persisted under .data/ */
export async function connectDb(uri?: string): Promise<string> {
  let target = uri || env.MONGODB_URI;
  if (!target) {
    if (env.NODE_ENV === 'production') throw new Error('MONGODB_URI is required in production');
    // 7.0 is a much smaller download than 8.x; the binary is cached outside the project so it is fetched only once.
    process.env.MONGOMS_VERSION ??= '7.0.14';
    process.env.MONGOMS_DOWNLOAD_DIR ??= path.join(os.homedir(), '.cache', 'mongodb-binaries');
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const persist = env.NODE_ENV === 'development';
    const dbPath = path.resolve('.data/mongo');
    if (persist) fs.mkdirSync(dbPath, { recursive: true });
    const srv = await MongoMemoryServer.create({
      instance: persist ? { dbPath, storageEngine: 'wiredTiger' } : {},
    });
    memoryServer = srv;
    target = srv.getUri();
    logger.info('Started embedded MongoDB (set MONGODB_URI to use a real database)', { persist });
  }
  await mongoose.connect(target);
  await mongoose.connection.syncIndexes().catch(() => undefined);
  return target;
}

export async function disconnectDb() {
  await mongoose.disconnect();
  if (memoryServer) await memoryServer.stop();
  memoryServer = null;
}
