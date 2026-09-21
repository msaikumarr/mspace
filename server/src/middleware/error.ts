import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const send = (status: number, code: string, message: string, details?: unknown) =>
    res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });

  if (err instanceof AppError) return send(err.status, err.code, err.message, err.details);
  if (err instanceof ZodError) {
    return send(422, 'VALIDATION_ERROR', err.issues[0] ? `${err.issues[0].path.join('.') || 'input'}: ${err.issues[0].message}` : 'Invalid input',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (err instanceof mongoose.Error.CastError) return send(400, 'INVALID_ID', 'Invalid identifier');
  if (err instanceof multer.MulterError) return send(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_ERROR', err.message);
  if ((err as { code?: number })?.code === 11000) return send(409, 'DUPLICATE', 'A record with these values already exists');
  if ((err as { type?: string })?.type === 'entity.parse.failed') return send(400, 'BAD_JSON', 'Malformed JSON body');

  logger.error('unhandled error', { path: req.path, method: req.method, err: err instanceof Error ? err.stack : String(err) });
  return send(500, 'INTERNAL_ERROR', 'Something went wrong');
}
