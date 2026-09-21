import { test, expect } from '@playwright/test';
import { register, goTo } from './helpers';

test.describe('team collaboration', () => {
  test('invites a teammate and chats with them in real time', async ({ browser }) => {
    const ownerCtx = await browser.newContext();
    const mateCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    const mate = await mateCtx.newPage();
    const base = test.info().project.use.baseURL!;
    for (const p of [owner, mate]) await p.goto(base);

    const mateUser = await register(mate, 'Teammate', 'Teammate WS');
    await register(owner, 'Boss', 'Shared Space');

    // invite an existing account: they're added straight away
    await goTo(owner, 'Members');
    await owner.getByLabel('Email').fill(mateUser.email);
    await owner.getByRole('button', { name: 'Send invite' }).click();
    await expect(owner.getByText('Member added')).toBeVisible();
    await expect(owner.getByText('Teammate', { exact: true }).first()).toBeVisible();

    // the teammate switches into the shared workspace
    await mate.reload();
    await mate.getByRole('button', { name: /Teammate WS/ }).click();
    await mate.getByRole('option', { name: /Shared Space/ }).click();
    await expect(mate.getByText(/Shared Space/).first()).toBeVisible();

    await goTo(owner, 'Chat');
    await goTo(mate, 'Chat');
    await expect(owner.getByRole('heading', { name: '# general' })).toBeVisible();
    await expect(mate.getByRole('heading', { name: '# general' })).toBeVisible();

    // delivered live, without the recipient reloading
    await owner.getByLabel('Message').fill('Welcome to the team!');
    await owner.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(mate.getByText('Welcome to the team!')).toBeVisible();

    await mate.getByLabel('Message').fill('Glad to be here');
    await mate.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(owner.getByText('Glad to be here')).toBeVisible();

    await ownerCtx.close();
    await mateCtx.close();
  });

  test('viewers cannot create projects', async ({ browser }) => {
    const ownerCtx = await browser.newContext();
    const viewerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    const viewer = await viewerCtx.newPage();
    const base = test.info().project.use.baseURL!;
    for (const p of [owner, viewer]) await p.goto(base);

    const viewerUser = await register(viewer, 'Watcher', 'Watcher WS');
    await register(owner, 'Admin', 'Locked Down');
    await goTo(owner, 'Members');
    await owner.getByLabel('Email').fill(viewerUser.email);
    await owner.getByLabel('Role').selectOption('viewer');
    await owner.getByRole('button', { name: 'Send invite' }).click();
    await expect(owner.getByText('Member added')).toBeVisible();

    await viewer.reload();
    await viewer.getByRole('button', { name: /Watcher WS/ }).click();
    await viewer.getByRole('option', { name: /Locked Down/ }).click();
    await goTo(viewer, 'Projects');
    await expect(viewer.getByRole('button', { name: /New project/ })).toHaveCount(0);
    await expect(viewer.getByText('A manager or admin needs to create a project.')).toBeVisible();

    await ownerCtx.close();
    await viewerCtx.close();
  });
});
