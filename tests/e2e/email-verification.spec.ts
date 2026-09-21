import { test, expect } from '@playwright/test';
import { register, waitForEmail, pathOf, uniqueEmail, goTo, PASSWORD } from './helpers';

/**
 * Email verification in a real browser. The app sends real email over SMTP to a capture server, and these tests open
 * the links from the emails that were actually delivered. Server-side rules (single use, expiry, what an unverified
 * address may not claim) are covered in server/tests/email-verification.test.ts.
 */
const banner = (page: import('@playwright/test').Page) => page.getByRole('status', { name: 'Email verification' });

test.describe('confirming an email address', () => {
  test('a new account is asked to confirm, gets a real email, and the link in it confirms the address', async ({ page, request }) => {
    const me = await register(page, 'Vera Fied', undefined, undefined, { verify: false });
    await expect(banner(page)).toContainText(me.email);
    await expect(banner(page).getByRole('button', { name: 'Resend email' })).toBeVisible();

    const mail = await waitForEmail(request, me.email, /Confirm your email/);
    expect(mail.text).toContain('Hi Vera,');
    const link = mail.links.find((l) => l.includes('/verify-email'))!;
    expect(link).toMatch(/\/verify-email\?token=[0-9a-f]{64}$/);

    await page.goto(pathOf(link));
    await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
    await page.getByRole('link', { name: 'Continue to M-Space' }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(banner(page)).toHaveCount(0); // and it stays gone
    await page.reload();
    await expect(banner(page)).toHaveCount(0);

    await goTo(page, 'Settings');
    await expect(page.getByText('✓ Verified')).toBeVisible();
  });

  test('the link works from a different browser than the one that signed up, and the first one notices', async ({ page, request, browser }) => {
    const me = await register(page, 'Elsewhere', undefined, undefined, { verify: false });
    const link = (await waitForEmail(request, me.email, /Confirm your email/)).links.find((l) => l.includes('/verify-email'))!;

    const other = await browser.newContext(); // e.g. their phone: no session here
    const p2 = await other.newPage();
    await p2.goto(pathOf(link));
    await expect(p2.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
    await expect(p2.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
    await other.close();

    // back in the first browser: the banner clears without signing in again
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test('a link can be used once, and a bad or incomplete one explains itself', async ({ page, request }) => {
    const me = await register(page, 'Once Only', undefined, undefined, { verify: false });
    const path = pathOf((await waitForEmail(request, me.email, /Confirm your email/)).links.find((l) => l.includes('/verify-email'))!);
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();

    await page.goto(path); // the same link again
    await expect(page.getByRole('alert')).toContainText('invalid, has expired, or has already been used');
    await expect(page.getByRole('heading', { name: 'We could not confirm your email' })).toBeVisible();

    await page.goto(`/verify-email?token=${'0'.repeat(64)}`);
    await expect(page.getByRole('alert')).toContainText('invalid, has expired, or has already been used');
    await page.goto('/verify-email');
    await expect(page.getByRole('alert')).toContainText('incomplete');
  });

  test('asking for another email is limited to once a minute, and says so', async ({ page }) => {
    await register(page, 'Impatient', undefined, undefined, { verify: false });
    await banner(page).getByRole('button', { name: 'Resend email' }).click(); // the sign-up email counts as the last one
    await expect(page.getByText(/Please wait \d+ seconds before asking for another email/)).toBeVisible();
  });
});

test.describe('what confirmation unlocks', () => {
  test('an invitation to an unconfirmed account waits, and applies the moment it is confirmed', async ({ page, request, browser }) => {
    const owner = await register(page, 'Boss', 'Boss HQ'); // confirmed
    const mateCtx = await browser.newContext();
    const mate = await mateCtx.newPage();
    const mateUser = await register(mate, 'Mate', 'Mate Space', undefined, { verify: false });

    await goTo(page, 'Members');
    await page.getByLabel('Email').fill(mateUser.email);
    await page.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText(/Invite saved\. They'll join once they sign up and confirm their email/)).toBeVisible();
    expect(owner.email).toBeTruthy();

    // they are told by email, and are not in the workspace yet
    const invite = await waitForEmail(request, mateUser.email, /invited you to Boss HQ/);
    expect(invite.text).toContain('as member');
    await mate.reload();
    await mate.getByRole('button', { name: /Mate Space/ }).click();
    await expect(mate.getByRole('option')).toHaveCount(1);
    await mate.keyboard.press('Escape');

    // confirming the address applies it
    const link = (await waitForEmail(request, mateUser.email, /Confirm your email/)).links.find((l) => l.includes('/verify-email'))!;
    await mate.goto(pathOf(link));
    await expect(mate.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
    await mate.getByRole('link', { name: 'Continue to M-Space' }).click();
    await mate.getByRole('button', { name: /Mate Space/ }).click();
    await expect(mate.getByRole('option', { name: /Boss HQ/ })).toBeVisible();
    await mateCtx.close();
  });

  test('an invitation to an address with no account yet arrives by email and is honoured once they sign up and confirm', async ({ page, request, browser }) => {
    await register(page, 'Inviter', 'Inviter Inc');
    const newcomer = uniqueEmail('newcomer');
    await goTo(page, 'Members');
    await page.getByLabel('Email').fill(newcomer);
    await page.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByText(/Invite saved/)).toBeVisible();
    expect((await waitForEmail(request, newcomer, /Inviter invited you to Inviter Inc/)).text).toContain('as member');

    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await register(p2, 'Newcomer', 'Newcomer Space', newcomer, { verify: false });
    await p2.getByRole('button', { name: /Newcomer Space/ }).click();
    await expect(p2.getByRole('option')).toHaveCount(1); // signing up alone is not enough
    await p2.keyboard.press('Escape');
    const link = (await waitForEmail(request, newcomer, /Confirm your email/)).links.find((l) => l.includes('/verify-email'))!;
    await p2.goto(pathOf(link));
    await p2.getByRole('link', { name: 'Continue to M-Space' }).click();
    await p2.getByRole('button', { name: /Newcomer Space/ }).click();
    await expect(p2.getByRole('option', { name: /Inviter Inc/ })).toBeVisible();
    await ctx.close();
  });
});

test.describe('password reset by email', () => {
  test('the reset link arrives by real email and works, and using it also confirms the address', async ({ page, request }) => {
    const me = await register(page, 'Forgetful', undefined, undefined, { verify: false });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(me.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If that account exists, a reset link has been sent.')).toBeVisible();

    const mail = await waitForEmail(request, me.email, /Reset your/);
    await page.goto(pathOf(mail.links.find((l) => l.includes('/reset-password'))!));
    await page.getByLabel('New password').fill('a-fresh-password-1');
    await page.getByLabel('Confirm password').fill('a-fresh-password-1');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email').fill(me.email);
    await page.getByLabel('Password').fill('a-fresh-password-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(banner(page)).toHaveCount(0); // reading the reset email proved the address
    expect(PASSWORD).not.toBe('a-fresh-password-1');
  });

  test('gives the same answer for an address that has no account, and sends nothing to it', async ({ page, request }) => {
    const stranger = uniqueEmail('stranger');
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(stranger);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If that account exists, a reset link has been sent.')).toBeVisible();
    await page.waitForTimeout(1000);
    const res = await request.get(`http://127.0.0.1:4501/?to=${encodeURIComponent(stranger)}`);
    expect(await res.json()).toEqual([]);
  });
});
