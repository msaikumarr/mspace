import { test, expect, type Page } from '@playwright/test';
import { register, uniqueEmail, goTo } from './helpers';

/**
 * Social sign-in in a real browser, against a local stand-in for Google/GitHub (server/tests/support/fakeOAuthProvider.ts)
 * that enforces the real protocol: PKCE, one-time codes and matching redirect URIs. The server-side rules and attacks
 * are covered in server/tests/oauth.test.ts; these check the journey a person actually takes.
 */
const fakeName = (provider: string) => new RegExp(`Sign in with ${provider}`, 'i');

/** Fills in the fake provider's account chooser and approves. */
async function approve(page: Page, provider: 'google' | 'github', who: { email: string; name?: string; sub?: string; unverified?: boolean }) {
  await expect(page.getByRole('heading', { name: fakeName(provider) })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(who.email);
  if (who.name) await page.getByLabel('Name').fill(who.name);
  if (who.sub) await page.getByLabel('Provider account id').fill(who.sub);
  if (who.unverified) await page.getByLabel('Email is not verified').check();
  await page.getByRole('button', { name: 'Authorize' }).click();
}

const signOut = async (page: Page) => {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); // exact: Settings also has "Sign out of all devices"
  await expect(page).toHaveURL(/\/login$/);
};

test.describe('social sign-in', () => {
  test('offers each configured provider on the sign-in and sign-up pages', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
    await page.goto('/register');
    await expect(page.getByRole('link', { name: 'Sign up with Google' })).toBeVisible();
  });

  test('a new person signs up with Google, lands in their own workspace, and signs in again later', async ({ page }) => {
    const who = { email: uniqueEmail('ada'), name: 'Ada Lovelace', sub: `g-${Date.now()}` };
    await page.goto('/login');
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await approve(page, 'google', who);

    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByText(who.email, { exact: true })).toBeVisible();
    await expect(page.getByText("Ada's Workspace").first()).toBeVisible();
    expect(page.url()).not.toMatch(/token|code=|state=/); // nothing sensitive is left in the address bar

    await page.reload(); // the session survives a reload
    await expect(page.getByText(who.email, { exact: true })).toBeVisible();

    await signOut(page);
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await approve(page, 'google', who); // same provider account
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByText(who.email, { exact: true })).toBeVisible();
    // the same account, not a second one: still exactly one workspace
    await page.getByRole('button', { name: /Ada's Workspace/ }).click();
    await expect(page.getByRole('option')).toHaveCount(1);
  });

  test('works with GitHub too', async ({ page }) => {
    const who = { email: uniqueEmail('linus'), name: 'Linus T', sub: String(Date.now()) };
    await page.goto('/register');
    await page.getByRole('link', { name: 'Sign up with GitHub' }).click();
    await approve(page, 'github', who);
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByText(who.email, { exact: true })).toBeVisible();
  });

  test('takes a signed-out visitor back to the page they were trying to open', async ({ page }) => {
    const who = { email: uniqueEmail('back'), name: 'Back Again' };
    await page.goto('/app/projects');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await approve(page, 'google', who);
    await expect(page).toHaveURL(/\/app\/projects$/);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  });

  test('explains what happened when consent is denied or the email is unverified', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await expect(page.getByRole('heading', { name: fakeName('google') })).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill(uniqueEmail('nope'));
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(page).toHaveURL(/\/login\?error=oauth_denied/);
    await expect(page.getByRole('alert').filter({ hasText: 'Sign-in was cancelled' })).toBeVisible();

    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await approve(page, 'google', { email: uniqueEmail('unverified'), unverified: true });
    await expect(page).toHaveURL(/\/login\?error=oauth_email_unverified/);
    await expect(page.getByRole('alert').filter({ hasText: 'has not verified your email' })).toBeVisible();
  });

  test('an UNCONFIRMED password account is not taken over by a matching Google email, but can connect it from Settings', async ({ page }) => {
    const me = await register(page, 'Pat Password', undefined, undefined, { verify: false }); // nobody has proven they own this address
    await signOut(page);

    // signing in with Google using the same address is refused...
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await approve(page, 'google', { email: me.email, name: 'Pat Password', sub: `pat-${Date.now()}` });
    await expect(page).toHaveURL(/\/login\?error=oauth_email_exists/);
    await expect(page.getByRole('alert').filter({ hasText: 'already exists' })).toBeVisible();

    // ...so they sign in with their password and connect it deliberately
    await page.getByLabel('Email').fill(me.email);
    await page.getByLabel('Password').fill(me.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app$/);
    await goTo(page, 'Settings');
    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
    await expect(page.getByText('Not connected').first()).toBeVisible();

    const sub = `pat-${Date.now()}`;
    await page.getByRole('button', { name: 'Connect Google' }).click();
    await approve(page, 'google', { email: me.email, name: 'Pat Password', sub });
    await expect(page).toHaveURL(/\/app\/settings$/);
    await expect(page.getByText('Google connected')).toBeVisible();
    await expect(page.getByText(`Connected as ${me.email}`)).toBeVisible();

    // and now Google alone gets them in
    await signOut(page);
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await approve(page, 'google', { email: me.email, sub });
    await expect(page).toHaveURL(/\/app\/settings$/); // back to the page they signed out from, same as a password sign-in
    // exact: on Settings the address also appears inside "Connected as …", and how soon that loads varies
    await expect(page.getByText(me.email, { exact: true })).toBeVisible();
  });

  test('a password account whose email was confirmed is signed in by Google with the same address', async ({ page }) => {
    const me = await register(page, 'Confirmed Carl'); // confirmed by default
    await signOut(page);
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await approve(page, 'google', { email: me.email, name: 'Confirmed Carl', sub: `carl-${Date.now()}` });
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByText(me.email, { exact: true })).toBeVisible();
    await goTo(page, 'Settings');
    await expect(page.getByText(`Connected as ${me.email}`)).toBeVisible(); // linked automatically, no takeover risk
  });

  test('a Google-only account sees it has no password, and cannot disconnect its only way in', async ({ page }) => {
    const who = { email: uniqueEmail('gonly'), name: 'Google Only' };
    await page.goto('/login');
    await page.getByRole('link', { name: 'Continue with Google' }).click();
    await approve(page, 'google', who);
    await expect(page).toHaveURL(/\/app$/);

    await goTo(page, 'Settings');
    await expect(page.getByText('this account has no password')).toBeVisible();
    await expect(page.getByLabel('Current password')).toHaveCount(0); // no form that could never work
    await expect(page.getByText(`Connected as ${who.email}`)).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Disconnect Google' }).click();
    await expect(page.getByText(/only way to sign in/)).toBeVisible();
    await expect(page.getByText(`Connected as ${who.email}`)).toBeVisible(); // still connected

    // set a password through the emailed link (shown inline in development), then disconnecting is allowed
    await page.getByRole('button', { name: 'Email me a link to set a password' }).click();
    await page.getByRole('link', { name: 'this link' }).click();
    await page.getByLabel('New password').fill('a-brand-new-pass-1');
    await page.getByLabel('Confirm password').fill('a-brand-new-pass-1');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email').fill(who.email);
    await page.getByLabel('Password').fill('a-brand-new-pass-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app$/);

    await goTo(page, 'Settings');
    await expect(page.getByLabel('Current password')).toBeVisible(); // now there is a password to change
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Disconnect Google' }).click();
    await expect(page.getByText('Disconnected')).toBeVisible();
    await expect(page.getByText('Not connected').first()).toBeVisible();
  });
});
