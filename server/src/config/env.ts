import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// Loads the repo-root .env regardless of the process's working directory. Plain `dotenv/config` looks in `process.cwd()`,
// which breaks for `npm run dev:server` (cwd is server/, not the repo root where .env actually lives). __dirname is
// server/src/config (or server/dist/config once built) either way, so three levels up is always the repo root. Harmless
// if the file doesn't exist (e.g. in Docker/production, where real env vars are injected directly).
//
// Skipped entirely in tests: vitest.config.ts sets its own deliberately empty/fake values (no Stripe key, no OAuth, no
// SMTP, ...) so every test run is isolated and reproducible. Loading a real developer .env here would leak whatever
// live credentials happen to be sitting in it into the test suite - exactly the kind of cross-environment leak this
// guard exists to prevent.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
}

// A `KEY=` line copied from .env.example arrives as '', which should mean "not set".
const blankAsUnset = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' ? undefined : v), s);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().optional(),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5'),
  AI_BASE_URL: z.string().default('https://api.anthropic.com'),
  STORAGE_DIR: z.string().default('uploads'),
  // Defaults to s3 when S3_BUCKET is set, otherwise local disk under STORAGE_DIR.
  STORAGE_DRIVER: blankAsUnset(z.enum(['local', 's3']).optional()),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(), // for MinIO, Cloudflare R2, etc.
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: blankAsUnset(z.enum(['true', 'false']).default('false')).transform((v) => v === 'true'),
  S3_PREFIX: z.string().default(''),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  // Outgoing email (verification, password reset, invitations) over SMTP, e.g. smtp://user:pass@host:587 or smtps://...@host:465.
  // Without it emails are only written to the log.
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('M-Space <no-reply@localhost>'),
  // 'auto': verified email addresses are required exactly when SMTP is configured. 'true' forces it, 'false' turns it off.
  REQUIRE_EMAIL_VERIFICATION: blankAsUnset(z.enum(['true', 'false', 'auto']).default('auto')),
  // Audio for the meeting assistant. Any OpenAI-compatible /audio/transcriptions server works (OpenAI, Groq, self-hosted).
  // Turned on when TRANSCRIBE_API_KEY or TRANSCRIBE_BASE_URL is set; without either, meetings take pasted transcripts only.
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_BASE_URL: z.string().optional(), // default https://api.openai.com/v1
  TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  TRANSCRIBE_CREDITS: z.coerce.number().int().min(1).default(5), // AI-request credits one recording costs
  MAX_AUDIO_MB: z.coerce.number().default(25), // OpenAI's limit; raise it for self-hosted servers
  ADMIN_EMAILS: z.string().default(''),
  // Billing. With STRIPE_SECRET_KEY set, paid plans go through Stripe Checkout and webhooks. Without it plan changes are
  // simulated (dev/demo) - refused in production unless ALLOW_SIMULATED_BILLING=true.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  STRIPE_API_BASE: z.string().optional(), // point at stripe-mock in tests, e.g. http://localhost:12111
  // Social sign-in. A provider is on when both its id and secret are set. Register
  // <OAUTH_REDIRECT_BASE or first CLIENT_URL>/api/auth/oauth/<google|github>/callback with the provider.
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  OAUTH_REDIRECT_BASE: z.string().optional(), // public origin of the app if it differs from CLIENT_URL
  OAUTH_ENDPOINTS_JSON: z.string().optional(), // per-provider endpoint overrides, for tests and proxies
  ALLOW_SIMULATED_BILLING: blankAsUnset(z.enum(['true', 'false']).default('false')).transform((v) => v === 'true'),
});

export const env = schema.parse(process.env);
if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}
if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
  throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
}
if (env.STRIPE_SECRET_KEY) {
  const missing = (['STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_BUSINESS'] as const).filter((k) => !env[k]);
  if (missing.length) throw new Error(`STRIPE_SECRET_KEY is set but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing`);
}
for (const p of ['GOOGLE', 'GITHUB'] as const) {
  if (!!env[`OAUTH_${p}_CLIENT_ID`] !== !!env[`OAUTH_${p}_CLIENT_SECRET`]) {
    throw new Error(`OAUTH_${p}_CLIENT_ID and OAUTH_${p}_CLIENT_SECRET must be set together`);
  }
}
if (env.NODE_ENV === 'production' && env.REQUIRE_EMAIL_VERIFICATION === 'true' && !env.SMTP_URL) {
  throw new Error('REQUIRE_EMAIL_VERIFICATION=true needs SMTP_URL, otherwise nobody can receive a verification link');
}
export const adminEmails = env.ADMIN_EMAILS.split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
