import { Request } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { badRequest } from './errors';

export const ok = <T>(data: T) => ({ success: true, data });
export const body = <T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> => schema.parse(req.body ?? {});
export const query = <T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> => schema.parse(req.query ?? {});

export const oid = (v: unknown, name = 'id') => {
  if (typeof v !== 'string' || !Types.ObjectId.isValid(v)) throw badRequest(`Invalid ${name}`, 'INVALID_ID');
  return new Types.ObjectId(v);
};
export const pid = (req: Request, name = 'id') => oid(req.params[name], name);
export type Id = Types.ObjectId | string;
