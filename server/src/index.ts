import http from 'http';
import { env } from './config/env';
import { connectDb, disconnectDb } from './config/db';
import { createApp } from './app';
import { initSockets, closeSockets } from './sockets';
import { startScheduler, stopScheduler } from './jobs/scheduler';
import { startQueue, stopQueue } from './jobs/queue';
import { logger } from './utils/logger';
import { emailConfigured } from './config/mail';

async function main() {
  if (env.NODE_ENV === 'production' && !emailConfigured()) {
    logger.warn('SMTP_URL is not set: no email can be sent, so password reset and email verification will not work. Set SMTP_URL to enable them.');
  }
  await connectDb();
  const server = http.createServer(createApp());
  initSockets(server);
  startScheduler();
  startQueue();
  server.listen(env.PORT, () => logger.info(`API listening on http://localhost:${env.PORT}`, { env: env.NODE_ENV }));

  const shutdown = async (sig: string) => {
    logger.info(`${sig} received, shutting down`);
    stopScheduler();
    await stopQueue(); // lets in-flight jobs finish; anything unfinished is picked up again after restart
    await closeSockets();
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error('fatal startup error', { err: e instanceof Error ? e.stack : String(e) });
  process.exit(1);
});
