import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import routes, { apiLimiter } from './routes';
import * as billingC from './controllers/billingController';
import { errorHandler, notFoundHandler } from './middleware/error';
import { logger } from './utils/logger';
import './services/rag/ragService'; // registers background job handlers
import './controllers/meetingController';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_URL.split(',').map((s) => s.trim()), credentials: true }));
  // Stripe signs the exact bytes it sends, so the webhook needs the raw body and must come before the JSON parser.
  app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), billingC.webhook);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => logger.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start }));
    next();
  });
  app.use('/api', apiLimiter, routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
