import { test, expect, type Page } from '@playwright/test';
import { register, goTo } from './helpers';

/**
 * The server test-suite covers the billing state machine. These check what the Billing page shows and does for each
 * state, by answering GET /api/billing with the shape a Stripe-backed server returns. The real server underneath runs
 * in simulated mode, so nothing here contacts Stripe.
 */
type Sub = { status?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; hasBillingAccount?: boolean; hasSubscription?: boolean };
interface State { paymentMode: 'stripe' | 'simulated' | 'disabled'; plan: 'free' | 'pro' | 'business'; sub?: Sub }

const IN_30_DAYS = new Date(Date.now() + 30 * 86400_000).toISOString();

/** Serves the real /api/billing response with the plan, subscription and mode replaced. `state` can be mutated mid-test. */
async function mockBilling(page: Page, state: State) {
  await page.route('**/api/billing', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    try {
      const res = await route.fetch();
      const data = await res.json();
      data.data.paymentMode = state.paymentMode;
      data.data.plan = data.data.plans.find((p: { id: string }) => p.id === state.plan);
      data.data.subscription = { status: 'active', cancelAtPeriodEnd: false, hasBillingAccount: false, hasSubscription: false, ...state.sub };
      await route.fulfill({ response: res, json: data });
    } catch {
      // a refetch can still be in flight when the test finishes and the page closes; nothing to answer then
    }
  });
}

/** Stops the browser actually leaving for a Stripe-hosted page. */
async function stubStripePages(page: Page) {
  await page.route('https://checkout.stripe.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>Stripe Checkout (stub)</h1>' }));
  await page.route('https://billing.stripe.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>Billing Portal (stub)</h1>' }));
}

const card = (page: Page, name: string) => page.locator('div', { has: page.getByRole('heading', { name, exact: true }) }).last();

test.describe('billing page', () => {
  test('a workspace without a subscription is sent to Stripe Checkout to upgrade', async ({ page }) => {
    await register(page, 'Upgrader');
    await mockBilling(page, { paymentMode: 'stripe', plan: 'free' });
    await stubStripePages(page);
    let posted: unknown;
    await page.route('**/api/billing/checkout', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, data: { url: 'https://checkout.stripe.test/pay/cs_1' } } });
    });

    await goTo(page, 'Billing');
    await expect(page.getByText('Demo billing')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Manage billing' })).toHaveCount(0); // nothing to manage yet
    await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
    await expect(page.getByRole('heading', { name: 'Stripe Checkout (stub)' })).toBeVisible();
    expect(posted).toEqual({ plan: 'pro' });
  });

  test('an active subscriber can switch plan, cancel, and open the billing portal', async ({ page }) => {
    await register(page, 'Subscriber');
    await mockBilling(page, { paymentMode: 'stripe', plan: 'pro', sub: { hasBillingAccount: true, hasSubscription: true, currentPeriodEnd: IN_30_DAYS } });
    await stubStripePages(page);
    const changes: unknown[] = [];
    await page.route('**/api/billing/change-plan', (route) => {
      changes.push(route.request().postDataJSON());
      return route.fulfill({ json: { success: true, data: { plan: { id: 'pro', name: 'Pro' }, subscription: {} } } });
    });
    await page.route('**/api/billing/portal', (route) => route.fulfill({ json: { success: true, data: { url: 'https://billing.stripe.test/p/1' } } }));

    await goTo(page, 'Billing');
    await expect(page.getByText(/renews/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Current plan' })).toBeDisabled();

    await page.getByRole('button', { name: 'Switch to Business' }).or(page.getByRole('button', { name: 'Upgrade to Business' })).click();
    await expect.poll(() => changes.length).toBe(1);
    expect(changes[0]).toEqual({ plan: 'business' }); // changes an existing subscription, not a new checkout

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Cancel subscription' }).click();
    await expect.poll(() => changes.length).toBe(2);
    expect(changes[1]).toEqual({ plan: 'free' });

    await page.getByRole('button', { name: 'Manage billing' }).click();
    await expect(page.getByRole('heading', { name: 'Billing Portal (stub)' })).toBeVisible();
  });

  test('a scheduled cancellation is explained and can be resumed', async ({ page }) => {
    await register(page, 'Wavering');
    await mockBilling(page, { paymentMode: 'stripe', plan: 'pro', sub: { hasBillingAccount: true, hasSubscription: true, cancelAtPeriodEnd: true, currentPeriodEnd: IN_30_DAYS } });
    let resumed: unknown;
    await page.route('**/api/billing/change-plan', (route) => {
      resumed = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, data: { plan: { id: 'pro', name: 'Pro' }, subscription: {} } } });
    });

    await goTo(page, 'Billing');
    await expect(page.getByText(/Your Pro plan ends on/)).toBeVisible();
    await expect(page.getByText(/ends /).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancellation scheduled' })).toBeDisabled();
    await page.getByRole('button', { name: 'Resume plan' }).click();
    await expect.poll(() => resumed).toEqual({ plan: 'pro' });
  });

  test('a failed payment shows a warning with a way to fix it', async ({ page }) => {
    await register(page, 'Declined');
    await mockBilling(page, { paymentMode: 'stripe', plan: 'pro', sub: { status: 'past_due', hasBillingAccount: true, hasSubscription: true, currentPeriodEnd: IN_30_DAYS } });
    await goTo(page, 'Billing');
    const alert = page.getByRole('alert').filter({ hasText: 'last payment failed' });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Manage billing' })).toBeVisible();
  });

  test('billing that is not configured explains itself and disables plan changes', async ({ page }) => {
    await register(page, 'Unconfigured');
    await mockBilling(page, { paymentMode: 'disabled', plan: 'free' });
    await goTo(page, 'Billing');
    await expect(page.getByRole('alert').filter({ hasText: 'payments are not configured' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch to Pro' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Switch to Business' })).toBeDisabled();
  });

  test('returning from Checkout waits for the webhook to activate the plan', async ({ page }) => {
    await register(page, 'Returning');
    const state: State = { paymentMode: 'stripe', plan: 'free' };
    await mockBilling(page, state);
    // the webhook lands a few seconds after the redirect
    setTimeout(() => { state.plan = 'pro'; state.sub = { hasBillingAccount: true, hasSubscription: true, currentPeriodEnd: IN_30_DAYS }; }, 3000);

    await page.goto('/app/billing?checkout=success');
    await expect(page.getByText('Payment received. Activating your plan')).toBeVisible();
    await expect(page.getByText("You're on the Pro plan. Thank you!")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Payment received. Activating your plan')).toHaveCount(0);
    await expect(page).not.toHaveURL(/checkout=/);
    await expect(page.getByRole('navigation', { name: 'Main' }).locator('..').getByText(/pro plan/i)).toBeVisible(); // sidebar reflects it
  });

  test('canceling out of Checkout says nothing was charged', async ({ page }) => {
    await register(page, 'Backed');
    await mockBilling(page, { paymentMode: 'stripe', plan: 'free' });
    await page.goto('/app/billing?checkout=canceled');
    await expect(page.getByText('Checkout canceled. You were not charged.')).toBeVisible();
    await expect(page).not.toHaveURL(/checkout=/);
  });

  test('demo mode still upgrades instantly against the real server', async ({ page }) => {
    await register(page, 'Demo');
    await goTo(page, 'Billing');
    await expect(page.getByText('Demo billing')).toBeVisible();
    await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
    await expect(page.getByText(/You're on the Pro plan/)).toBeVisible();
    await expect(card(page, 'Pro').getByText('Current')).toBeVisible();
  });
});
