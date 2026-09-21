import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'password123';
export const INBOX = 'http://127.0.0.1:4501'; // the capture server the app's outgoing email goes to (see playwright.config.ts)

let n = 0;
export const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${++n}@e2e.test`;

/**
 * Registers through the UI and waits for the app shell. Returns the credentials used.
 *
 * This server requires verified email addresses, so by default the new account is confirmed straight away (using the
 * token the API echoes outside production) and existing specs behave as if it were not a concern. Pass
 * `{ verify: false }` to stay unverified, which is what the verification specs do.
 */
export async function register(
  page: Page, name: string, workspaceName = `${name} WS`, email = uniqueEmail(name.toLowerCase().replace(/\W/g, '')), opts: { verify?: boolean } = {},
) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Workspace name (optional)').fill(workspaceName);
  const registered = page.waitForResponse((r) => r.url().endsWith('/api/auth/register') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create account' }).click();
  const { data } = await (await registered).json();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  if (opts.verify !== false && data.devVerifyToken) {
    const res = await page.request.post('/api/auth/verify-email', { data: { token: data.devVerifyToken } });
    expect(res.ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Email verification' })).toHaveCount(0);
  }
  return { name, email, password: PASSWORD, workspaceName };
}

/** Waits for an email to `to` whose subject matches, and returns it. Reads the capture server's inbox. */
export async function waitForEmail(request: APIRequestContext, to: string, subject: RegExp, timeoutMs = 15_000) {
  type Mail = { to: string[]; subject: string; text: string; links: string[] };
  let found: Mail | undefined;
  await expect
    .poll(async () => {
      const res = await request.get(`${INBOX}/?to=${encodeURIComponent(to)}`);
      const all = (await res.json()) as Mail[];
      found = [...all].reverse().find((m) => subject.test(m.subject));
      return !!found;
    }, { timeout: timeoutMs, message: `no email to ${to} matching ${subject}` })
    .toBe(true);
  return found!;
}

/** A link from an email as a path on the app under test (the email holds the app's public address). */
export const pathOf = (link: string) => {
  const u = new URL(link);
  return u.pathname + u.search;
};

export async function goTo(page: Page, nav: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: nav }).click();
}

/** Owner-only shortcut: the demo billing endpoint switches plans instantly. */
export async function upgradeToPro(page: Page) {
  await goTo(page, 'Billing');
  await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
  await expect(page.getByText(/You're on the Pro plan/)).toBeVisible();
}

export async function createProject(page: Page, name: string) {
  await goTo(page, 'Projects');
  await page.getByRole('button', { name: /New project/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}
