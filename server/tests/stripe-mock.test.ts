import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Stripe from 'stripe';
import { setup, teardown, signup } from './helpers';
import { configureBilling, applySubscription } from '../src/services/billing/stripeBilling';
import { Workspace } from '../src/models/Workspace';

/**
 * Talks to stripe-mock (github.com/stripe/stripe-mock, or the `stripe/stripe-mock` Docker image) with the real Stripe
 * SDK. stripe-mock validates every request against Stripe's OpenAPI spec, so these prove the parameters the app sends
 * are ones Stripe accepts, and that the response fields it reads exist where it looks for them. Payments and
 * webhooks are covered in stripe-billing.test.ts; this file is about the wire format.
 */
const URL_ = process.env.TEST_STRIPE_MOCK_URL;

describe.skipIf(!URL_)('against stripe-mock (needs TEST_STRIPE_MOCK_URL)', () => {
  beforeAll(setup);
  afterAll(teardown);
  afterEach(() => configureBilling());

  const use = () =>
    configureBilling({
      secretKey: 'sk_test_123', webhookSecret: 'whsec_x', apiBase: URL_, clientUrl: 'http://localhost:5173',
      prices: { pro: 'price_pro_mock', business: 'price_business_mock' },
    });
  const sdk = () => {
    const u = new URL(URL_!);
    return new Stripe('sk_test_123', { host: u.hostname, port: Number(u.port), protocol: 'http' });
  };

  it('Checkout session parameters are valid', async () => {
    use();
    const a = await signup('MockCheckout');
    const r = await a.post('/billing/checkout', { plan: 'pro' });
    expect(r.body.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body.data.url).toMatch(/^https?:\/\//);
  });

  it('Billing Portal session parameters are valid', async () => {
    use();
    const a = await signup('MockPortal');
    await Workspace.updateOne({ _id: a.workspaceId }, { 'subscription.stripeCustomerId': 'cus_mock' });
    const r = await a.post('/billing/portal');
    expect(r.body.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body.data.url).toMatch(/^https?:\/\//);
  });

  it('subscription update parameters are valid for switching plan, cancelling and resuming', async () => {
    use();
    const a = await signup('MockChange');
    await Workspace.updateOne({ _id: a.workspaceId }, { plan: 'pro', 'subscription.stripeCustomerId': 'cus_mock', 'subscription.stripeSubscriptionId': 'sub_mock' });
    for (const plan of ['business', 'free']) {
      const r = await a.post('/billing/change-plan', { plan });
      expect(r.body.error, `change-plan to ${plan}`).toBeUndefined();
      expect(r.status).toBe(200);
    }
  });

  it('reads plan, status, period end and cancel flag from the subscription shape Stripe actually returns', async () => {
    use();
    const a = await signup('MockShape');
    const s = await sdk().subscriptions.retrieve('sub_mock');
    expect(s.items.data.length).toBeGreaterThan(0);
    expect(typeof s.items.data[0].current_period_end).toBe('number'); // where the app reads the period end from
    expect(typeof s.cancel_at_period_end).toBe('boolean');

    const sub = { ...s, status: 'active', metadata: { workspaceId: a.workspaceId }, items: { ...s.items, data: [{ ...s.items.data[0], price: { ...s.items.data[0].price, id: 'price_business_mock' } }] } } as Stripe.Subscription;
    await applySubscription(sub);
    const w = (await Workspace.findById(a.workspaceId))!;
    expect(w.plan).toBe('business');
    expect(w.subscription!.currentPeriodEnd).toBeInstanceOf(Date);
    expect(Number.isNaN(w.subscription!.currentPeriodEnd!.getTime())).toBe(false);
    expect(w.subscription!.stripeCustomerId).toBeTruthy();
  });
});
