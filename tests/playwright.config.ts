import { defineConfig, devices } from '@playwright/test';

const API_PORT = 4100;
const WEB_PORT = 5273;
const OAUTH_PORT = 4300;
const FAKE = `http://127.0.0.1:${OAUTH_PORT}`;
const SMTP_PORT = 4500;
const INBOX_PORT = 4501;
const STT_PORT = 4400;
const STT = `http://127.0.0.1:${STT_PORT}/v1`;

// NODE_ENV=test gives the API a throwaway in-memory MongoDB, no Redis and no rate limiting,
// so every run starts clean and never touches your dev data.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
  webServer: [
    {
      // A real SMTP server that keeps what it receives, with the inbox readable as JSON over HTTP, so tests can follow the
      // links in the emails the app actually sends (server/tests/support/smtpCapture.ts).
      command: 'npx tsx tests/support/smtpCapture.ts',
      cwd: '../server',
      url: `http://127.0.0.1:${INBOX_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(SMTP_PORT), HTTP_PORT: String(INBOX_PORT) },
    },
    {
      // A local stand-in for an OpenAI-compatible speech-to-text server (server/tests/support/fakeTranscriptionServer.ts).
      command: 'npx tsx tests/support/fakeTranscriptionServer.ts',
      cwd: '../server',
      url: `http://127.0.0.1:${STT_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(STT_PORT) },
    },
    {
      // A local stand-in for Google/GitHub that speaks the real protocol, so social sign-in runs end to end in a browser.
      command: 'npx tsx tests/support/fakeOAuthProvider.ts',
      cwd: '../server',
      url: `${FAKE}/google/userinfo`, // answers 401 without a token, which is enough to know it is up
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(OAUTH_PORT) },
    },
    {
      command: 'npx tsx src/index.ts',
      cwd: '../server',
      url: `http://localhost:${API_PORT}/api/health`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        STORAGE_DIR: '.data/e2e-uploads',
        JWT_SECRET: 'e2e-secret-e2e-secret-123',
        CLIENT_URL: `http://localhost:${WEB_PORT}`,
        AI_API_KEY: '', // force the deterministic offline AI path
        // outgoing email goes to the capture server above, which also switches on email verification ("auto")
        SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}`,
        MAIL_FROM: 'M-Space <no-reply@mspace.test>',
        TRANSCRIBE_BASE_URL: STT,
        TRANSCRIBE_API_KEY: 'fake-transcribe-key',
        OAUTH_GOOGLE_CLIENT_ID: 'fake-client',
        OAUTH_GOOGLE_CLIENT_SECRET: 'fake-secret',
        OAUTH_GITHUB_CLIENT_ID: 'fake-client',
        OAUTH_GITHUB_CLIENT_SECRET: 'fake-secret',
        OAUTH_ENDPOINTS_JSON: JSON.stringify({
          google: { authorize: `${FAKE}/google/authorize`, token: `${FAKE}/google/token`, userinfo: `${FAKE}/google/userinfo` },
          github: { authorize: `${FAKE}/github/authorize`, token: `${FAKE}/github/token`, userinfo: `${FAKE}/github/user`, emails: `${FAKE}/github/emails` },
        }),
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: '../client',
      url: `http://localhost:${WEB_PORT}`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: { VITE_API_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
