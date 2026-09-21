import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { setup, teardown, app, signup, addMember, makeProject, type Actor } from './helpers';
import { configureBilling, billingMode } from '../src/services/billing/stripeBilling';
import { Workspace } from '../src/models/Workspace';
import { AuditLog, Notification } from '../src/models/Misc';
import { PLANS } from '../src/config/plans';

beforeAll(setup);
afterAll(teardown);

const SECRET = 'whsec_test_secret';
const CLIENT = 'http://localhost:5173';
const real = new Stripe('sk_test_unused');

// ---- a small in-memory Stripe: enough state to make the app's calls and webhook re-reads meaningful ----
let subs: Record<string, any>;
let calls: { fn: string; args: any[] }[];
let failRetrieve = 0;
let evtN = 0;

const period = () => Math.floor(Date.now() / 1000) + 30 * 86400;
const makeSub = (workspaceId: string, over: Record<string, any> = {}) => ({
  id: 'sub_1', object: 'subscription', status: 'active', customer: 'cus_1', cancel_at_period_end: false,
  metadata: { workspaceId }, items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, current_period_end: period() }] }, ...over,
});
const withPrice = (s: any, price: string) => ({ ...s, items: { data: [{ ...s.items.data[0], price: { id: price } }] } });

const fakeStripe = () => ({
  checkout: { sessions: { create: async (p: any) => { calls.push({ fn: 'checkout.create', args: [p] }); return { id: 'cs_1', url: 'https://checkout.stripe.test/pay/cs_1' }; } } },
  billingPortal: { sessions: { create: async (p: any) => { calls.push({ fn: 'portal.create', args: [p] }); return { url: 'https://billing.stripe.test/p/1' }; } } },
  subscriptions: {
    retrieve: async (id: string) => {
      calls.push({ fn: 'subs.retrieve', args: [id] });
      if (failRetrieve > 0) { failRetrieve--; throw new Error('stripe is down'); }
      if (!subs[id]) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
      return structuredClone(subs[id]);
    },
    update: async (id: string, p: any) => {
      calls.push({ fn: 'subs.update', args: [id, p] });
      const s = subs[id];
      if (p.cancel_at_period_end !== undefined) s.cancel_at_period_end = p.cancel_at_period_end;
      if (p.items) s.items.data[0].price = { id: p.items[0].price };
      return structuredClone(s);
    },
  },
  webhooks: real.webhooks, // the real signature verification
});

const event = (type: string, object: unknown, id = `evt_${++evtN}`) => ({ id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } });
const deliver = (e: unknown, opts: { secret?: string; header?: string | null } = {}) => {
  const payload = JSON.stringify(e);
  const header = opts.header === undefined ? real.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? SECRET }) : opts.header;
  const r = request(app).post('/api/billing/webhook').set('Content-Type', 'application/json');
  if (header !== null) r.set('Stripe-Signature', header);
  return r.send(payload);
};
const ws = async (a: Actor) => (await Workspace.findById(a.workspaceId))!;
const useStripe = () => configureBilling({ secretKey: 'sk_test_123', webhookSecret: SECRET, prices: { pro: 'price_pro', business: 'price_business' }, clientUrl: CLIENT }, fakeStripe());

beforeEach(() => { subs = {}; calls = []; failRetrieve = 0; });
afterEach(() => configureBilling()); // back to the test environment's simulated billing

/** Gives a workspace a live Pro subscription the way a completed Checkout would, via a signed webhook. */
async function subscribe(a: Actor, price = 'price_pro', id = 'sub_1', customer = 'cus_1') {
  subs[id] = withPrice(makeSub(a.workspaceId, { id, customer }), price);
  const r = await deliver(event('customer.subscription.created', subs[id]));
  expect(r.status).toBe(200);
}

describe('billing mode', () => {
  it('is simulated outside production, disabled in production unless allowed, and stripe when keys exist', () => {
    expect(billingMode()).toBe('simulated'); // test environment
    configureBilling({ production: true, simulatedAllowed: false });
    expect(billingMode()).toBe('disabled');
    configureBilling({ production: true, simulatedAllowed: true });
    expect(billingMode()).toBe('simulated');
    configureBilling({ production: true, secretKey: 'sk_test_1' });
    expect(billingMode()).toBe('stripe');
  });

  it('refuses plan changes when billing is disabled, so an unconfigured production server cannot hand out upgrades', async () => {
    configureBilling({ production: true, simulatedAllowed: false });
    const a = await signup('NoBilling');
    const r = await a.post('/billing/change-plan', { plan: 'business' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('BILLING_NOT_CONFIGURED');
    expect((await ws(a)).plan).toBe('free');
    expect((await a.get('/billing')).body.data.paymentMode).toBe('disabled');
  });
});

describe('checkout and plan changes (Stripe mode)', () => {
  it('will not grant a paid plan without payment', async () => {
    useStripe();
    const a = await signup('Freeloader');
    const r = await a.post('/billing/change-plan', { plan: 'pro' });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('CHECKOUT_REQUIRED');
    expect((await ws(a)).plan).toBe('free');
    expect(calls).toHaveLength(0);
  });

  it('creates a Checkout session tied to the workspace, and only for owners and admins', async () => {
    useStripe();
    const a = await signup('Buyer');
    const r = await a.post('/billing/checkout', { plan: 'business' });
    expect(r.status).toBe(200);
    expect(r.body.data.url).toBe('https://checkout.stripe.test/pay/cs_1');
    const p = calls[0].args[0];
    expect(p).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_business', quantity: 1 }],
      client_reference_id: a.workspaceId,
      customer_email: a.email,
      metadata: { workspaceId: a.workspaceId, plan: 'business' },
      subscription_data: { metadata: { workspaceId: a.workspaceId, plan: 'business' } },
      success_url: `${CLIENT}/app/billing?checkout=success`,
      cancel_url: `${CLIENT}/app/billing?checkout=canceled`,
    });

    const member = await addMember(a, 'member');
    expect((await member.post('/billing/checkout', { plan: 'pro' })).status).toBe(403);
    expect((await a.post('/billing/checkout', { plan: 'free' })).status).toBe(422);
    expect((await a.post('/billing/checkout', { plan: 'enterprise' })).status).toBe(422);
  });

  it('reuses the Stripe customer on a later checkout, and blocks a second live subscription', async () => {
    useStripe();
    const a = await signup('Repeat');
    await subscribe(a);
    const dup = await a.post('/billing/checkout', { plan: 'business' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_SUBSCRIBED');

    // after the subscription ends, checkout works again and attaches to the same customer
    subs.sub_1.status = 'canceled';
    await deliver(event('customer.subscription.deleted', subs.sub_1));
    calls = [];
    expect((await a.post('/billing/checkout', { plan: 'pro' })).status).toBe(200);
    expect(calls[0].args[0]).toMatchObject({ customer: 'cus_1' });
    expect(calls[0].args[0].customer_email).toBeUndefined();
  });

  it('is unavailable when Stripe is not configured', async () => {
    const a = await signup('NoStripe'); // simulated mode
    const r = await a.post('/billing/checkout', { plan: 'pro' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('STRIPE_NOT_CONFIGURED');
    expect((await a.post('/billing/portal')).status).toBe(400);
  });

  it('moves between paid plans with proration, then follows Stripe\'s record', async () => {
    useStripe();
    const a = await signup('Switcher');
    await subscribe(a, 'price_pro');
    calls = [];
    const r = await a.post('/billing/change-plan', { plan: 'business' });
    expect(r.status).toBe(200);
    const upd = calls.find((c) => c.fn === 'subs.update')!;
    expect(upd.args[0]).toBe('sub_1');
    expect(upd.args[1]).toMatchObject({ items: [{ id: 'si_1', price: 'price_business' }], proration_behavior: 'create_prorations', cancel_at_period_end: false });
    expect((await ws(a)).plan).toBe('business');
    expect(r.body.data.plan.id).toBe('business');
  });

  it('cancelling schedules the end of the paid period instead of dropping the plan now, and can be undone', async () => {
    useStripe();
    const a = await signup('Leaver');
    await subscribe(a);
    const r = await a.post('/billing/change-plan', { plan: 'free' });
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.fn === 'subs.update')!.args[1]).toEqual({ cancel_at_period_end: true });
    let w = await ws(a);
    expect(w.plan).toBe('pro'); // still paid up until the period ends
    expect(w.subscription!.cancelAtPeriodEnd).toBe(true);
    expect(r.body.data.subscription.cancelAtPeriodEnd).toBe(true);
    expect(await AuditLog.exists({ workspaceId: a.workspaceId, action: 'SUBSCRIPTION_CHANGED', 'metadata.scheduled': true })).toBeTruthy();

    // choosing the current plan again resumes it
    const resume = await a.post('/billing/change-plan', { plan: 'pro' });
    expect(resume.status).toBe(200);
    w = await ws(a);
    expect(w.subscription!.cancelAtPeriodEnd).toBe(false);
    expect((await a.post('/billing/change-plan', { plan: 'pro' })).body.error.code).toBe('SAME_PLAN');
  });

  it('blocks a downgrade the workspace does not fit, before touching Stripe', async () => {
    useStripe();
    const a = await signup('TooBig');
    await subscribe(a);
    for (let i = 0; i < PLANS.free.maxProjects + 1; i++) await makeProject(a, `P${i}`);
    calls = [];
    const r = await a.post('/billing/change-plan', { plan: 'free' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('DOWNGRADE_BLOCKED');
    expect(calls.filter((c) => c.fn === 'subs.update')).toHaveLength(0);
  });

  it('opens the billing portal only once there is a billing account', async () => {
    useStripe();
    const a = await signup('Portal');
    const none = await a.post('/billing/portal');
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('NO_BILLING_ACCOUNT');
    await subscribe(a);
    const r = await a.post('/billing/portal');
    expect(r.body.data.url).toBe('https://billing.stripe.test/p/1');
    expect(calls.find((c) => c.fn === 'portal.create')!.args[0]).toEqual({ customer: 'cus_1', return_url: `${CLIENT}/app/billing` });
  });
});

describe('webhook', () => {
  it('rejects a missing, malformed or wrongly-signed request without changing anything', async () => {
    useStripe();
    const a = await signup('Forged');
    subs.sub_1 = makeSub(a.workspaceId);
    const e = event('customer.subscription.created', subs.sub_1);
    expect((await deliver(e, { header: null })).status).toBe(400);
    expect((await deliver(e, { header: 'garbage' })).status).toBe(400);
    const wrong = await deliver(e, { secret: 'whsec_someone_else' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await ws(a)).plan).toBe('free');
  });

  it('rejects a body altered after signing', async () => {
    useStripe();
    const a = await signup('Tampered');
    subs.sub_1 = makeSub(a.workspaceId);
    const payload = JSON.stringify(event('customer.subscription.created', subs.sub_1));
    const header = real.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const r = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload.replace('price_pro', 'price_business'));
    expect(r.status).toBe(400);
  });

  it('activates the plan from a signed subscription event, and keeps Stripe ids out of API responses', async () => {
    useStripe();
    const a = await signup('Paid');
    expect((await a.get('/analytics')).body.data.locked).toBe(true);
    await subscribe(a);
    const w = await ws(a);
    expect(w.plan).toBe('pro');
    expect(w.subscription).toMatchObject({ status: 'active', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', cancelAtPeriodEnd: false });
    expect(w.subscription!.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
    expect((await a.get('/analytics')).body.data.locked).toBe(false); // the plan's features are live

    const listed = JSON.stringify((await a.get('/workspaces')).body);
    const overview = JSON.stringify((await a.get('/billing')).body);
    for (const body of [listed, overview]) expect(body).not.toMatch(/cus_1|sub_1|stripeCustomerId|stripeSubscriptionId/);
    expect((await a.get('/billing')).body.data.subscription).toMatchObject({ status: 'active', hasBillingAccount: true });
    expect(await AuditLog.exists({ workspaceId: a.workspaceId, action: 'SUBSCRIPTION_CHANGED', 'metadata.source': 'stripe' })).toBeTruthy();
    expect(await Notification.exists({ userId: a.id, type: 'BILLING' })).toBeTruthy();
  });

  it('handles Checkout completion by syncing its subscription', async () => {
    useStripe();
    const a = await signup('Checkout');
    subs.sub_9 = withPrice(makeSub(a.workspaceId, { id: 'sub_9', customer: 'cus_9' }), 'price_business');
    const r = await deliver(event('checkout.session.completed', { id: 'cs_9', object: 'checkout.session', mode: 'subscription', subscription: 'sub_9', customer: 'cus_9' }));
    expect(r.status).toBe(200);
    expect((await ws(a)).plan).toBe('business');
  });

  it('ignores a redelivered event id', async () => {
    useStripe();
    const a = await signup('Dupe');
    subs.sub_1 = makeSub(a.workspaceId);
    const e = event('customer.subscription.created', subs.sub_1, 'evt_fixed_1');
    expect((await deliver(e)).body).toMatchObject({ handled: true, duplicate: false });
    calls = [];
    const again = await deliver(e);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ handled: false, duplicate: true });
    expect(calls).toHaveLength(0); // not even re-read from Stripe
    expect(await Notification.countDocuments({ userId: a.id, type: 'BILLING' })).toBe(1);
  });

  it('applies Stripe\'s latest state even when events arrive out of order', async () => {
    useStripe();
    const a = await signup('Reordered');
    subs.sub_1 = withPrice(makeSub(a.workspaceId), 'price_business'); // Stripe's truth: already upgraded
    const stale = withPrice(makeSub(a.workspaceId), 'price_pro'); // an older event shows up late
    expect((await deliver(event('customer.subscription.updated', stale))).status).toBe(200);
    expect((await ws(a)).plan).toBe('business');
  });

  it('tracks cancel-at-period-end, payment trouble, and final cancellation', async () => {
    useStripe();
    const a = await signup('Lifecycle');
    await subscribe(a);

    subs.sub_1.cancel_at_period_end = true;
    await deliver(event('customer.subscription.updated', subs.sub_1));
    let w = await ws(a);
    expect([w.plan, w.subscription!.cancelAtPeriodEnd]).toEqual(['pro', true]);

    subs.sub_1.cancel_at_period_end = false;
    subs.sub_1.status = 'past_due';
    await deliver(event('customer.subscription.updated', subs.sub_1));
    w = await ws(a);
    expect([w.plan, w.subscription!.status]).toEqual(['pro', 'past_due']); // grace period while Stripe retries

    subs.sub_1.status = 'unpaid';
    await deliver(event('customer.subscription.updated', subs.sub_1));
    w = await ws(a);
    expect(w.plan).toBe('free'); // Stripe gave up collecting

    subs.sub_1.status = 'active';
    await deliver(event('customer.subscription.updated', subs.sub_1)); // they paid the invoice
    expect((await ws(a)).plan).toBe('pro');

    subs.sub_1.status = 'canceled';
    await deliver(event('customer.subscription.deleted', subs.sub_1));
    w = await ws(a);
    expect([w.plan, w.subscription!.status, w.subscription!.stripeSubscriptionId]).toEqual(['free', 'canceled', undefined]);
    expect(w.subscription!.stripeCustomerId).toBe('cus_1'); // kept so a later checkout reuses the customer
  });

  it('handles a deleted subscription that Stripe can no longer return', async () => {
    useStripe();
    const a = await signup('Gone');
    await subscribe(a);
    const gone = structuredClone(subs.sub_1);
    delete subs.sub_1; // retrieve now answers resource_missing
    expect((await deliver(event('customer.subscription.deleted', gone))).status).toBe(200);
    expect((await ws(a)).plan).toBe('free');
  });

  it('does not let a stale cancellation of an old subscription cancel the current one', async () => {
    useStripe();
    const a = await signup('Resubscribed');
    await subscribe(a, 'price_pro', 'sub_new', 'cus_1');
    const old = withPrice(makeSub(a.workspaceId, { id: 'sub_old', status: 'canceled' }), 'price_pro');
    subs.sub_old = old;
    await deliver(event('customer.subscription.deleted', old));
    const w = await ws(a);
    expect(w.plan).toBe('pro');
    expect(w.subscription!.stripeSubscriptionId).toBe('sub_new');
  });

  it('does not grant a plan for an unrecognised price or an unpaid first attempt, and tolerates unknown workspaces', async () => {
    useStripe();
    const a = await signup('Odd');
    subs.sub_1 = withPrice(makeSub(a.workspaceId), 'price_from_another_product');
    expect((await deliver(event('customer.subscription.created', subs.sub_1))).status).toBe(200);
    expect((await ws(a)).plan).toBe('free');

    subs.sub_2 = makeSub(a.workspaceId, { id: 'sub_2', status: 'incomplete' });
    await deliver(event('customer.subscription.created', subs.sub_2));
    expect((await ws(a)).plan).toBe('free');

    subs.sub_3 = makeSub('64b0000000000000000000aa', { id: 'sub_3', customer: 'cus_nobody' });
    expect((await deliver(event('customer.subscription.created', subs.sub_3))).status).toBe(200);
  });

  it('warns the workspace owner when a payment fails', async () => {
    useStripe();
    const a = await signup('Declined');
    await subscribe(a, 'price_pro', 'sub_declined', 'cus_declined'); // customer ids are unique per workspace in real Stripe
    await Notification.deleteMany({ userId: a.id });
    const r = await deliver(event('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_declined' }));
    expect(r.status).toBe(200);
    const n = await Notification.findOne({ userId: a.id, type: 'BILLING' });
    expect(n?.title).toMatch(/Payment failed/);
  });

  it('acknowledges event types it does not use', async () => {
    useStripe();
    const r = await deliver(event('customer.created', { id: 'cus_x', object: 'customer' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, handled: false });
  });

  it('answers 5xx when Stripe is unreachable so it retries, and succeeds on the retry', async () => {
    useStripe();
    const a = await signup('Retry');
    subs.sub_1 = makeSub(a.workspaceId);
    const e = event('customer.subscription.created', subs.sub_1, 'evt_retry_1');
    failRetrieve = 1;
    expect((await deliver(e)).status).toBeGreaterThanOrEqual(500);
    expect((await ws(a)).plan).toBe('free');
    const second = await deliver(e);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(false); // the failed attempt was not recorded as done
    expect((await ws(a)).plan).toBe('pro');
  });

  it('refuses webhooks when Stripe is not configured', async () => {
    const r = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', 't=1,v1=x').send('{}');
    expect(r.status).toBe(503);
  });
});
