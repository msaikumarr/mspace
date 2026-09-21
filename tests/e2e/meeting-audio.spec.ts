import { test, expect, type Locator, type Page } from '@playwright/test';
import { register, goTo, upgradeToPro, createProject } from './helpers';

/**
 * Meeting recordings in a real browser, against a local OpenAI-compatible speech-to-text stand-in
 * (server/tests/support/fakeTranscriptionServer.ts). The server-side rules, retries and refunds are covered in
 * server/tests/audio-meetings.test.ts; these check the journey a person takes.
 */
const wav = (extra = 256) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(extra, 7)]);
const SPEECH = /I will write the release notes by Friday/;

async function openNewMeeting(page: Page) {
  await goTo(page, 'Meetings');
  await page.getByRole('button', { name: /New meeting/ }).click();
  return page.getByRole('dialog', { name: 'New meeting' });
}

/** The action-item row (the deadlines list can quote the same sentence, so pick the one with a checkbox). */
// (`has` must be relative to each row, so the checkbox locator starts from the page, not from the dialog)
const actionItem = (dialog: Locator, text: string) => dialog.getByRole('listitem').filter({ has: dialog.page().getByRole('checkbox') }).filter({ hasText: text });

async function uploadRecording(page: Page, title: string, file: { name: string; buffer: Buffer }) {
  const dialog = await openNewMeeting(page);
  await dialog.getByRole('tab', { name: 'Upload recording' }).click();
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Recording').setInputFiles({ ...file, mimeType: 'audio/wav' });
  return dialog;
}

test.describe('meeting recordings', () => {
  test('a recording is transcribed and analysed, and its action items become tasks after approval', async ({ page }) => {
    await register(page, 'Recorder');
    await upgradeToPro(page);
    await createProject(page, 'Release 1');

    const dialog = await uploadRecording(page, 'Weekly sync', { name: 'sync.wav', buffer: wav() });
    await expect(dialog.getByText(/sync\.wav · /)).toBeVisible();
    await dialog.getByRole('button', { name: 'Transcribe & analyse' }).click();

    // the detail view opens straight away and follows the meeting through to READY
    const detail = page.getByRole('dialog', { name: 'Weekly sync' });
    await expect(detail.getByText('Transcribed from a recording')).toBeVisible({ timeout: 30_000 });
    await expect(detail.getByRole('heading', { name: 'Summary' })).toBeVisible();
    await detail.getByText('Transcript', { exact: true }).click();
    await expect(detail.locator('pre')).toContainText(SPEECH); // the raw transcript block (the sentence is also quoted in the summary)

    // spoken commitments have no speaker, so they arrive unassigned for a person to assign
    const item = actionItem(detail, 'Write the release notes by Friday');
    await expect(item).toBeVisible();
    await expect(item.getByLabel('Assignee')).toHaveValue('');
    await item.getByRole('checkbox').check();
    await detail.getByLabel('Target project').selectOption({ label: 'Release 1' });
    await detail.getByRole('button', { name: /Create 1 task/ }).click();
    await expect(page.getByText('1 task created')).toBeVisible();
    await expect(item.getByText('✓ Task created')).toBeVisible();

    // the meeting list marks it as a recording
    await page.keyboard.press('Escape');
    await expect(page.getByText(/🎙 recording/)).toBeVisible();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  });

  test('says why a recording could not be transcribed', async ({ page }) => {
    await register(page, 'Unlucky');
    await upgradeToPro(page);
    const dialog = await uploadRecording(page, 'Bad audio', { name: 'corrupt.wav', buffer: wav() });
    await dialog.getByRole('button', { name: 'Transcribe & analyse' }).click();

    const detail = page.getByRole('dialog', { name: 'Bad audio' });
    await expect(detail.getByRole('alert')).toContainText('corrupted or unsupported', { timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  });

  test('reports a silent recording instead of producing an empty analysis', async ({ page }) => {
    await register(page, 'Quiet');
    await upgradeToPro(page);
    const dialog = await uploadRecording(page, 'Nobody spoke', { name: 'silent.wav', buffer: wav() });
    await dialog.getByRole('button', { name: 'Transcribe & analyse' }).click();
    await expect(page.getByRole('dialog', { name: 'Nobody spoke' }).getByRole('alert')).toContainText('No speech was detected', { timeout: 30_000 });
  });

  test('refuses a file that is not audio, and one that is too large, before wasting an upload', async ({ page }) => {
    await register(page, 'Careful');
    await upgradeToPro(page);

    // too large: caught in the browser, so the button stays disabled
    let dialog = await uploadRecording(page, 'Huge', { name: 'huge.wav', buffer: Buffer.concat([wav(), Buffer.alloc(26 * 1024 * 1024)]) });
    await expect(dialog.getByText(/over the 25 MB limit/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Transcribe & analyse' })).toBeDisabled();
    await page.keyboard.press('Escape');

    // not audio: the server checks the content and says so
    dialog = await openNewMeeting(page);
    await dialog.getByRole('tab', { name: 'Upload recording' }).click();
    await dialog.getByLabel('Title').fill('Fake');
    await dialog.getByLabel('Recording').setInputFiles({ name: 'notes.wav', mimeType: 'audio/wav', buffer: Buffer.from('this is just text pretending to be audio') });
    await dialog.getByRole('button', { name: 'Transcribe & analyse' }).click();
    await expect(dialog.getByRole('alert')).toContainText('does not match its extension');
  });

  test('pasting a transcript still works alongside recordings', async ({ page }) => {
    await register(page, 'Paster');
    await upgradeToPro(page);
    const dialog = await openNewMeeting(page);
    await expect(dialog.getByRole('tab', { name: 'Paste transcript' })).toHaveAttribute('aria-selected', 'true');
    await dialog.getByLabel('Title').fill('Pasted sync');
    await dialog.getByLabel('Transcript').fill("Sam: We decided to ship on 2030-03-01.\nKim: I'll write the release notes by Friday.");
    await dialog.getByRole('button', { name: 'Analyse', exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Pasted sync' });
    await expect(actionItem(detail, 'Write the release notes by Friday')).toBeVisible({ timeout: 30_000 });
    await expect(detail.getByText('Transcribed from a recording')).toHaveCount(0);
  });
});
