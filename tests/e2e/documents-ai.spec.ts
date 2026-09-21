import { test, expect } from '@playwright/test';
import { register, goTo, upgradeToPro, createProject } from './helpers';

const REQUIREMENTS = `Requirements Specification

The system must support single sign-on using SAML for enterprise customers. Authentication tokens should expire after fifteen minutes.

Billing. Invoices are generated on the first day of each month. The finance team needs to export invoices as CSV.

Performance. The dashboard must load in under two seconds. The team should implement pagination for the audit log.`;

test.describe('documents and AI (offline mode)', () => {
  test('uploads a document, waits for processing, and answers with a cited source', async ({ page }) => {
    await register(page, 'Researcher');
    await upgradeToPro(page);

    await goTo(page, 'Documents');
    await page.locator('input[type=file]').setInputFiles({ name: 'requirements.md', mimeType: 'text/markdown', buffer: Buffer.from(REQUIREMENTS) });
    await expect(page.getByText('requirements.md')).toBeVisible();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByPlaceholder(/authentication requirements/).fill('How long until authentication tokens expire?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.getByText(/fifteen minutes/).first()).toBeVisible();
    await expect(page.getByText('Sources')).toBeVisible();
    await expect(page.getByText(/requirements\.md/).nth(1)).toBeVisible();
  });

  test('gates document Q&A behind the Pro plan', async ({ page }) => {
    await register(page, 'Freeloader');
    await goTo(page, 'Documents');
    await page.getByPlaceholder(/authentication requirements/).fill('What are the requirements?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('link', { name: 'See plans' })).toBeVisible();
  });

  test('suggests tasks from pasted text and only creates them after approval', async ({ page }) => {
    await register(page, 'Approver');
    await createProject(page, 'Requirements Sprint');

    await goTo(page, 'AI Copilot');
    await page.getByRole('tab', { name: 'Generate tasks' }).click();
    await page.getByPlaceholder(/The system must support SSO/).fill('- The system must support SSO for enterprise users\n- We need to export invoices as CSV\n- Someone should implement audit log pagination');
    await page.getByRole('button', { name: /Suggest tasks/ }).click();
    await expect(page.getByText(/Review \d+ suggestion/)).toBeVisible();

    // nothing exists yet
    await goTo(page, 'Projects');
    await page.getByRole('link', { name: /Requirements Sprint/ }).click();
    await expect(page.getByText('0/0')).toBeVisible();

    await goTo(page, 'AI Copilot');
    await page.getByRole('tab', { name: 'Generate tasks' }).click();
    await page.getByPlaceholder(/The system must support SSO/).fill('- The system must support SSO for enterprise users\n- We need to export invoices as CSV');
    await page.getByRole('button', { name: /Suggest tasks/ }).click();
    await page.getByRole('button', { name: /^Add \d+ to project$/ }).click();
    await expect(page.getByText(/tasks? added/)).toBeVisible();

    await goTo(page, 'Projects');
    await page.getByRole('link', { name: /Requirements Sprint/ }).click();
    await expect(page.getByText(/SSO/).first()).toBeVisible();
  });

  test('copilot answers questions about overdue work', async ({ page }) => {
    await register(page, 'Asker');
    await goTo(page, 'AI Copilot');
    await page.getByLabel('Ask the Copilot').fill('Which tasks are overdue?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Nothing is overdue right now.')).toBeVisible();
  });
});
