import { Request, Response } from 'express';
import { z } from 'zod';
import { PLANS } from '../config/plans';
import { Workspace } from '../models/Workspace';
import { changePlan, usageSummary } from '../services/billing/usageService';
import { billingMode, changeSubscription, createCheckoutSession, createPortalSession, handleWebhook } from '../services/billing/stripeBilling';
import { audit } from '../services/auditService';
import { body, ok } from '../utils/http';
import { AppError, badRequest } from '../utils/errors';

const publicSubscription = (ws: { subscription?: any }) => {
  const s = ws.subscription || {};
  return { status: s.status || 'active', currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: !!s.cancelAtPeriodEnd, hasBillingAccount: !!s.stripeCustomerId, hasSubscription: !!s.stripeSubscriptionId };
};

export async function overview(req: Request, res: Response) {
  const ws = req.ctx!.workspace;
  res.json(ok({ ...(await usageSummary(ws)), subscription: publicSubscription(ws), plans: Object.values(PLANS), paymentMode: billingMode() }));
}

/**
 * Plan change. With Stripe this never grants a paid plan by itself: it moves an existing subscription (prorated) or
 * schedules cancellation, and the plan follows Stripe's record. Without Stripe it switches directly (dev/demo only).
 */
export async function changeBillingPlan(req: Request, res: Response) {
  const { plan } = body(z.object({ plan: z.enum(['free', 'pro', 'business']) }), req);
  const ws = req.ctx!.workspace;
  const mode = billingMode();
  if (mode === 'disabled') throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Plan changes are unavailable: payments are not configured on this server.');
  const resuming = ws.plan === plan && ws.subscription?.cancelAtPeriodEnd;
  if (ws.plan === plan && !resuming) throw badRequest('Already on this plan', 'SAME_PLAN');

  const from = ws.plan;
  const record = (metadata: Record<string, unknown>) =>
    audit({ workspaceId: ws._id, actorId: req.user!._id, action: 'SUBSCRIPTION_CHANGED', targetType: 'workspace', targetId: String(ws._id), metadata });
  if (mode === 'simulated') {
    await changePlan(ws, plan);
    await record({ from, to: plan, mode });
  } else {
    await changeSubscription(ws, plan);
    // A real plan change is audited when Stripe's record is applied; cancelling only schedules one for period end.
    if (plan === 'free') await record({ from, to: plan, mode, scheduled: true });
  }
  const fresh = await Workspace.findById(ws._id);
  res.json(ok({ ...(await usageSummary(fresh!)), subscription: publicSubscription(fresh!) }));
}

const requireStripe = () => {
  if (billingMode() !== 'stripe') throw new AppError(400, 'STRIPE_NOT_CONFIGURED', 'Card payments are not enabled on this server.');
};

export async function checkout(req: Request, res: Response) {
  requireStripe();
  const { plan } = body(z.object({ plan: z.enum(['pro', 'business']) }), req);
  res.json(ok({ url: await createCheckoutSession(req.ctx!.workspace, { email: req.user!.email }, plan) }));
}

export async function portal(req: Request, res: Response) {
  requireStripe();
  res.json(ok({ url: await createPortalSession(req.ctx!.workspace) }));
}

/** Stripe calls this. It is mounted before the JSON parser because the signature covers the exact raw bytes. */
export async function webhook(req: Request, res: Response) {
  const r = await handleWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.header('stripe-signature'));
  res.json({ received: true, ...r });
}
