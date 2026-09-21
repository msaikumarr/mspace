import { test, expect } from '@playwright/test';
import { register, uniqueEmail, PASSWORD } from './helpers';

test.describe('authentication', () => {
  test('registers, creates a workspace, signs out and back in', async ({ page }) => {
    const user = await register(page, 'Ada Lovelace', 'Analytical Engines');
    await expect(page.getByText('Analytical Engines').first()).toBeVisible();
    await expect(page.getByText(user.email, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByText('Analytical Engines').first()).toBeVisible();
  });

  test('keeps the session across a reload', async ({ page }) => {
    await register(page, 'Grace Hopper');
    await page.reload();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });

  test('rejects bad credentials and invalid input', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(uniqueEmail('nobody'));
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/register');
    await page.getByLabel('Full name').fill('X');
    await page.getByLabel('Work email').fill('not-an-email');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter a valid email')).toBeVisible();
    await expect(page.getByText('At least 8 characters', { exact: true }).first()).toBeVisible();
  });

  test('refuses a duplicate email', async ({ page, context }) => {
    const user = await register(page, 'First');
    const other = await context.browser()!.newContext();
    const p2 = await other.newPage();
    await p2.goto(`${test.info().project.use.baseURL}/register`);
    await p2.getByLabel('Full name').fill('Second');
    await p2.getByLabel('Work email').fill(user.email.toUpperCase());
    await p2.getByLabel('Password').fill(PASSWORD);
    await p2.getByRole('button', { name: 'Create account' }).click();
    await expect(p2.getByRole('alert')).toBeVisible();
    await other.close();
  });

  test('redirects anonymous visitors away from the app', async ({ page }) => {
    await page.goto('/app/projects');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('resets a forgotten password in development mode', async ({ page }) => {
    const user = await register(page, 'Forgetful');
    await page.getByRole('button', { name: 'Sign out' }).click();

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(user.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await page.getByRole('link', { name: 'this reset link' }).click();

    await page.getByLabel('New password').fill('brand-new-password');
    await page.getByLabel('Confirm password').fill('brand-new-password');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill('brand-new-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/app$/);
  });
});
