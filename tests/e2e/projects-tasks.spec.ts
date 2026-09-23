import { test, expect } from '@playwright/test';
import { register, createProject } from './helpers';

test.describe('projects and Kanban', () => {
  test('creates a project and tasks, drags a card to Done, and persists it', async ({ page }) => {
    await register(page, 'Planner');
    await createProject(page, 'Website Relaunch');

    for (const title of ['Write copy', 'Design hero']) {
      await page.getByRole('button', { name: /New task/ }).click();
      const dialog = page.getByRole('dialog', { name: 'New task' });
      await dialog.getByLabel('Title').fill(title);
      await dialog.getByRole('button', { name: 'Create task' }).click();
      await expect(dialog).toBeHidden();
    }

    const todo = page.getByRole('region', { name: 'Todo' });
    const done = page.getByRole('region', { name: 'Done' });
    await expect(todo.getByRole('button', { name: 'Task Write copy' })).toBeVisible();
    await expect(todo.getByRole('button', { name: 'Task Design hero' })).toBeVisible();

    // HTML5 drag-and-drop needs intermediate mouse moves for Chromium to fire dragover/drop
    const card = todo.getByRole('button', { name: 'Task Write copy' });
    await done.scrollIntoViewIfNeeded(); // the board scrolls sideways; measure only after both columns are on screen
    const from = (await card.boundingBox())!;
    const to = (await done.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 25 });
    await page.mouse.up();
    await expect(done.getByRole('button', { name: 'Task Write copy' })).toBeVisible();
    await expect(page.getByText('1/2')).toBeVisible();

    // the move was saved through the API, not just applied optimistically
    await page.reload();
    await expect(page.getByRole('region', { name: 'Done' }).getByRole('button', { name: 'Task Write copy' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Todo' }).getByRole('button', { name: 'Task Design hero' })).toBeVisible();
  });

  test('opens a task, comments on it, and filters the board', async ({ page }) => {
    await register(page, 'Commenter');
    await createProject(page, 'Support Queue');

    await page.getByRole('button', { name: /New task/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByLabel('Title').fill('Investigate login bug');
    await dialog.getByLabel('Priority').selectOption('URGENT');
    await dialog.getByRole('button', { name: 'Create task' }).click();

    await page.getByRole('button', { name: 'Task Investigate login bug' }).click();
    await expect(page).toHaveURL(/task=/);
    await page.getByPlaceholder(/Write a comment/).fill('Reproduced on staging');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Reproduced on staging')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByLabel('Filter by priority').selectOption('LOW');
    await expect(page.getByRole('button', { name: 'Task Investigate login bug' })).toHaveCount(0);
    await page.getByLabel('Filter by priority').selectOption('URGENT');
    await expect(page.getByRole('button', { name: 'Task Investigate login bug' })).toBeVisible();

    await page.getByRole('tab', { name: 'List' }).click();
    await expect(page.getByRole('cell', { name: 'Investigate login bug' })).toBeVisible();
  });

  test('flags a past-due task as overdue on the board', async ({ page }) => {
    await register(page, 'Analyst');
    await createProject(page, 'Late Project');
    await page.getByRole('button', { name: /New task/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByLabel('Title').fill('Should have shipped');
    await dialog.getByLabel('Due date').fill('2020-01-01');
    await dialog.getByRole('button', { name: 'Create task' }).click();
    await expect(page.getByText('Overdue ·')).toBeVisible();
  });
});
