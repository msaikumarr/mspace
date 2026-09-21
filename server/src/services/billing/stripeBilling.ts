import Stripe from 'stripe';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { Workspace, WorkspaceDoc, Member } from '../../models/Workspace';
import { WebhookEvent } from '../../models/Misc';
import { getPlan, type PlanId } from '../../config/plans';
import { audit } from '../auditService';
import { notify } from '../notifications/notificationService';
import { emitToWorkspace } from '../../sockets';
import { assertPlanFits } from './usageService';
import { AppError, badRequest, conflict } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * Stripe billing: Checkout to start a subscription, the Billing Portal for payment methods and invoices, and
 * webhooks as the only thing that decides what plan a workspace is on.
 *
 * Every subscription event is treated as a hint to re-read the subscription from Stripe and apply that latest
 * state. That makes handling idempotent and immune to duplicate or out-of-order deliveries.
 */
export type BillingMode = 'stripe' | 'simulated' | 'disabled';
type PaidPlan = Exclude<PlanId, 'free'>;

interface BillingConfig {
  secretKey?: string;
  webhookSecret?: string;
  prices: Record<PaidPlan, string | undefined>;
  apiBase?: string;
  production: boolean;
  simulatedAllowed: boolean;
  clientUrl: string;
}

const fromEnv = (): BillingConfig => ({
  secretKey: env.STRIPE_SECRET_KEY || undefined,
  webhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
  prices: { pro: env.STRIPE_PRICE_PRO || undefined, business: env.STRIPE_PRICE_BUSINESS || undefined },
  apiBase: env.STRIPE_API_BASE || undefined,
  production: env.NODE_ENV === 'production',
  simulatedAllowed: env.ALLOW_SIMULATED_BILLING,
  clientUrl: env.CLIENT_URL.split(',')[0].trim().replace(/\/$/, ''),
});

let cfg = fromEnv();
let client: Stripe | null = null;

/** Test hook: override configuration and/or the Stripe client. Call with no arguments to restore the environment. */
export function configureBilling(o?: Partial<BillingConfig>, stripeClient?: unknown) {
  cfg = { ...fromEnv(), ...o };
  client = (stripeClient as Stripe) ?? null;
}

export function billingMode(): BillingMode {
  if (cfg.secretKey) return 'stripe';
  return !cfg.production || cfg.simulatedAllowed ? 'simulated' : 'disabled';
}

function stripe(): Stripe {
  if (client) return client;
  if (!cfg.secretKey) throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Payments are not configured on this server');
  const opts: Stripe.StripeConfig = { maxNetworkRetries: 2, appInfo: { name: 'M-Space' } };
  if (cfg.apiBase) {
    const u = new URL(cfg.apiBase);
    Object.assign(opts, { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), protocol: u.protocol.replace(':', '') });
  }
  client = new Stripe(cfg.secretKey, opts);
  return client;
}

const planForPrice = (priceId: string): PaidPlan | undefined =>
  (Object.keys(cfg.prices) as PaidPlan[]).find((p) => cfg.prices[p] === priceId);

const priceForPlan = (plan: PaidPlan) => {
  const p = cfg.prices[plan];
  if (!p) throw new AppError(503, 'BILLING_NOT_CONFIGURED', `No Stripe price is configured for the ${getPlan(plan).name} plan`);
  return p;
};

const hasLiveSubscription = (ws: WorkspaceDoc) => !!ws.subscription?.stripeSubscriptionId;

// ---------------------------------------------------------------------------------------------------------------
// Requests from signed-in users
// ---------------------------------------------------------------------------------------------------------------

/** Starts a Stripe Checkout session for a workspace without a subscription; returns the hosted payment URL. */
export async function createCheckoutSession(ws: WorkspaceDoc, actor: { email: string }, plan: PaidPlan) {
  if (hasLiveSubscription(ws)) throw conflict('This workspace already has a subscription. Change plan or manage billing instead.', 'ALREADY_SUBSCRIBED');
  const customer = ws.subscription?.stripeCustomerId;
  const workspaceId = String(ws._id);
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceForPlan(plan), quantity: 1 }],
    client_reference_id: workspaceId,
    ...(customer ? { customer } : { customer_email: actor.email }),
    // Copied onto the subscription, so every later subscription event says which workspace it belongs to.
    subscription_data: { metadata: { workspaceId, plan } },
    metadata: { workspaceId, plan },
    allow_promotion_codes: true,
    success_url: `${cfg.clientUrl}/app/billing?checkout=success`,
    cancel_url: `${cfg.clientUrl}/app/billing?checkout=canceled`,
  });
  if (!session.url) throw new AppError(502, 'CHECKOUT_FAILED', 'Stripe did not return a checkout URL');
  return session.url;
}

/** Stripe-hosted page for payment methods, invoices and cancelling. */
export async function createPortalSession(ws: WorkspaceDoc) {
  const customer = ws.subscription?.stripeCustomerId;
  if (!customer) throw badRequest('This workspace has no billing account yet. Subscribe to a paid plan first.', 'NO_BILLING_ACCOUNT');
  const session = await stripe().billingPortal.sessions.create({ customer, return_url: `${cfg.clientUrl}/app/billing` });
  return session.url;
}

/**
 * Changes an existing subscription. Upgrades and switches are prorated; choosing Free cancels at the end of the
 * period already paid for. The plan the workspace is on is then updated from Stripe's own record.
 */
export async function changeSubscription(ws: WorkspaceDoc, plan: PlanId) {
  const id = ws.subscription?.stripeSubscriptionId;
  if (!id) throw new AppError(402, 'CHECKOUT_REQUIRED', 'Start a subscription first to move to a paid plan.');
  await assertPlanFits(ws, plan);
  const s = stripe();
  const updated =
    plan === 'free'
      ? await s.subscriptions.update(id, { cancel_at_period_end: true })
      : await s.subscriptions.update(id, {
          items: [{ id: (await s.subscriptions.retrieve(id)).items.data[0].id, price: priceForPlan(plan) }],
          cancel_at_period_end: false,
          proration_behavior: 'create_prorations',
        });
  return applySubscription(updated);
}

// ---------------------------------------------------------------------------------------------------------------
// Applying Stripe's state to a workspace
// ---------------------------------------------------------------------------------------------------------------

async function findWorkspace(sub: Stripe.Subscription) {
  const fromMeta = sub.metadata?.workspaceId;
  if (fromMeta && Types.ObjectId.isValid(fromMeta)) {
    const ws = await Workspace.findById(fromMeta);
    if (ws) return ws;
  }
  return (
    (await Workspace.findOne({ 'subscription.stripeSubscriptionId': sub.id })) ||
    (await Workspace.findOne({ 'subscription.stripeCustomerId': typeof sub.customer === 'string' ? sub.customer : sub.customer.id }))
  );
}

/** Writes a Stripe subscription onto its workspace. Safe to call repeatedly with the same or newer state. */
export async function applySubscription(sub: Stripe.Subscription) {
  const ws = await findWorkspace(sub);
  if (!ws) {
    logger.warn('stripe subscription does not match any workspace', { subscription: sub.id });
    return null;
  }
  const current = ws.subscription?.stripeSubscriptionId;
  const set: Record<string, unknown> = { 'subscription.stripeCustomerId': typeof sub.customer === 'string' ? sub.customer : sub.customer.id };
  const unset: Record<string, ''> = {};

  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
    // A stale cancellation of an old subscription must not wipe out a newer one.
    if (current && current !== sub.id) return ws;
    Object.assign(set, { plan: 'free', 'subscription.status': 'canceled', 'subscription.cancelAtPeriodEnd': false });
    Object.assign(unset, { 'subscription.stripeSubscriptionId': '', 'subscription.currentPeriodEnd': '' });
  } else if (sub.status === 'incomplete') {
    return ws; // first payment not completed yet: nothing to grant
  } else {
    const item = sub.items.data[0];
    const paid = item ? planForPrice(item.price.id) : undefined;
    if (!paid) {
      logger.error('stripe subscription uses a price that is not configured', { subscription: sub.id, price: item?.price.id });
      return ws;
    }
    // "unpaid" means Stripe has stopped collecting: keep the record so it can be settled, but stop granting the plan.
    const unpaid = sub.status === 'unpaid';
    Object.assign(set, {
      plan: unpaid ? 'free' : paid,
      'subscription.status': sub.status === 'past_due' || unpaid ? 'past_due' : 'active',
      'subscription.stripeSubscriptionId': sub.id,
      'subscription.cancelAtPeriodEnd': sub.cancel_at_period_end,
    });
    if (item?.current_period_end) set['subscription.currentPeriodEnd'] = new Date(item.current_period_end * 1000);
  }

  const before = ws.plan;
  const fresh = await Workspace.findByIdAndUpdate(ws._id, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { returnDocument: 'after' });
  if (fresh && fresh.plan !== before) {
    await audit({ workspaceId: ws._id, action: 'SUBSCRIPTION_CHANGED', targetType: 'workspace', targetId: String(ws._id), metadata: { from: before, to: fresh.plan, source: 'stripe' } });
    await notifyBillingAdmins(ws._id, `Your plan is now ${getPlan(fresh.plan).name}`, sub.status === 'canceled' ? 'The subscription has ended.' : undefined);
  }
  emitToWorkspace(ws._id, 'billing:updated', { plan: fresh?.plan });
  return fresh;
}

/** Re-reads a subscription from Stripe and applies it; falls back to the event's copy if it no longer exists. */
async function syncSubscription(id: string, fallback?: Stripe.Subscription) {
  try {
    return await applySubscription(await stripe().subscriptions.retrieve(id));
  } catch (e: any) {
    if (e?.code === 'resource_missing' && fallback) return applySubscription(fallback);
    throw e;
  }
}

async function notifyBillingAdmins(workspaceId: Types.ObjectId, title: string, body?: string) {
  const admins = await Member.find({ workspaceId, role: { $in: ['owner', 'admin'] } }).select('userId');
  await notify({ workspaceId, userIds: admins.map((m) => m.userId), type: 'BILLING', title, body, link: '/app/billing' });
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------------------------

/** Verifies the signature on the raw request body, then handles the event. Throws a 400 for a bad signature. */
export async function handleWebhook(rawBody: Buffer, signature: string | undefined) {
  if (!cfg.secretKey || !cfg.webhookSecret) throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Payments are not configured on this server');
  if (!signature) throw badRequest('Missing Stripe-Signature header', 'INVALID_SIGNATURE');
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
  } catch {
    throw badRequest('Invalid webhook signature', 'INVALID_SIGNATURE');
  }
  if (await WebhookEvent.exists({ eventId: event.id })) return { handled: false, duplicate: true, type: event.type };

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await syncSubscription(sub.id, event.type === 'customer.subscription.deleted' ? { ...sub, status: 'canceled' } : undefined);
      break;
    }
    case 'checkout.session.completed': {
      const s = event.data.object;
      const id = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
      if (s.mode === 'subscription' && id) await syncSubscription(id);
      break;
    }
    case 'invoice.payment_failed': {
      const customer = typeof event.data.object.customer === 'string' ? event.data.object.customer : event.data.object.customer?.id;
      const ws = customer ? await Workspace.findOne({ 'subscription.stripeCustomerId': customer }) : null;
      if (ws) await notifyBillingAdmins(ws._id, 'Payment failed', 'We could not charge your card. Update your payment method to keep your plan.');
      break;
    }
    default:
      return { handled: false, duplicate: false, type: event.type };
  }
  // Recorded only after success, so a failed attempt is retried by Stripe rather than skipped.
  await WebhookEvent.create({ eventId: event.id, type: event.type }).catch(() => undefined);
  return { handled: true, duplicate: false, type: event.type };
}
