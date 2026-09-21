import { Request, Response, NextFunction } from 'express';
import { Plan } from '../config/plans';
import { assertAiQuota, assertFeature, recordUsage } from '../services/billing/usageService';
import { Usage } from '../models/Misc';

/** Plan feature gate, e.g. requireFeature('rag'). Must run after workspaceContext. */
export const requireFeature = (f: keyof Plan['features']) => (req: Request, _res: Response, next: NextFunction) => {
  assertFeature(req.ctx!.workspace, f);
  next();
};

/**
 * Checks the monthly AI quota, charges the credit up-front (so concurrent requests see it) and refunds it
 * if the request ends in an error, so failed calls don't burn the customer's credits.
 */
export const aiUsage = (requestType: string, credits = 1) => async (req: Request, res: Response, next: NextFunction) => {
  await assertAiQuota(req.ctx!.workspace);
  const rec = await recordUsage(req.ctx!.workspaceId, req.user!._id, requestType, credits);
  res.on('finish', () => {
    if (res.statusCode >= 400) Usage.deleteOne({ _id: rec._id }).catch(() => undefined);
  });
  next();
};
