# AI Productivity SaaS

Multi-tenant team platform: projects and Kanban tasks, real-time chat, document Q&A (RAG), an AI Copilot, meeting assistant, analytics, RBAC and plan-based usage limits.

**Stack:** React 19 + TypeScript + Vite + Tailwind + TanStack Query (client) · Node + Express 5 + Mongoose + Socket.IO (server) · MongoDB · optional Redis.

## Quick start (development)

```bash
npm run install:all
cp .env.example .env        # optional in dev
npm run dev:server          # http://localhost:4000 (embedded MongoDB if MONGODB_URI is unset)
npm run dev:client          # http://localhost:5173, proxies /api and /socket.io to the server
```

With no `AI_API_KEY`, AI features fall back to offline heuristics (extractive summaries, pattern-based task extraction).

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Server unit and integration tests (Vitest + Supertest, embedded MongoDB) |
| `npm run test:e2e` | Playwright browser tests in `tests/e2e` (starts its own API and client on ports 4100/5273 with a throwaway database; first time run `npm run install:browsers --prefix tests`) |
| `npm run lint` | Typechecks server and client |
| `npm run build` | Builds server and client |

## Docker

```bash
cp .env.example .env        # set JWT_SECRET (and AI_API_KEY if you want LLM answers)
docker compose up --build   # app at http://localhost:8080
```

Services: `frontend` (nginx, serves the SPA and proxies `/api` and `/socket.io`), `backend`, `mongodb`, `redis`. Uploads persist in the `uploads` volume. For production, prefer managed MongoDB and Redis and point `MONGODB_URI` / `REDIS_URL` at them.

## CI

`.github/workflows/ci.yml` runs typecheck, tests and build for server and client, the Playwright end-to-end suite, and `docker compose build` on every push and pull request.

## Background jobs

Document and meeting processing run on a job queue. With `REDIS_URL` set the queue is BullMQ on Redis: jobs survive restarts, retry once with backoff and can be shared by several instances (delivery is at-least-once, so job handlers are idempotent). Without Redis an in-process queue is used, and jobs in flight are lost if the server stops. The Redis queue tests run when `TEST_REDIS_URL` is set (CI does this).

## File storage

Uploads (documents and chat attachments) go through a storage layer with two drivers: local disk under `STORAGE_DIR` (default), or S3 and S3-compatible services (AWS, Cloudflare R2, MinIO) when `S3_BUCKET` is set. Files are stored under `<workspaceId>/docs|chat/<id>`. With S3, any instance or queue worker can read any file, which is what running several backends needs. On AWS leave the access keys empty to use an IAM role; for other providers set `S3_ENDPOINT` and usually `S3_FORCE_PATH_STYLE=true`.

Switching drivers does **not** move existing files: records written earlier keep pointing at the old location, so copy the old files into the bucket under the same keys before switching an installation that already has uploads.

## Email and address verification

The server sends email over SMTP: `SMTP_URL` (for example `smtp://user:pass@smtp.example.com:587` or `smtps://...:465`) and `MAIL_FROM`. Any provider that offers SMTP works: Amazon SES, SendGrid, Postmark, Mailgun, Resend, a Gmail app password, or Mailpit while developing. **Without `SMTP_URL` no email is sent, so password reset cannot work in production**; the server logs a warning at startup. In development the reset and confirmation links are shown on the page instead.

Emails sent: an address confirmation link (24 hours, single use, replaced when a new one is sent), password reset, and invitations to people who have no account yet. Sending never fails the request that triggered it, and every email can be requested again.

**Verified addresses** are required whenever email is configured (`REQUIRE_EMAIL_VERIFICATION=auto`; set `true` or `false` to force it). It exists because an email address gets trusted in three places:
- **Invitations.** Invitations sent to an address are applied only once its owner has confirmed it, and inviting an existing but unconfirmed account keeps the invitation pending. Otherwise whoever registered an address first could claim what was meant for someone else.
- **Platform admin.** An `ADMIN_EMAILS` address becomes platform admin only after it is confirmed.
- **Social sign-in.** A Google or GitHub email is linked automatically to an existing account only if that account's address is confirmed.

A password reset, a social sign-in and connecting a provider under the account's own address all prove ownership too, and count as confirming it. Unconfirmed people can otherwise use the app normally; they see a banner with a resend button (limited to once a minute). Without email configured nothing changes: invitations apply at once, as before.

Existing accounts predate this and are all unconfirmed, so turning on SMTP shows every existing password user the banner and holds invitations to them until they confirm.

## Meeting recordings

The meeting assistant accepts a recording as well as a pasted transcript. It is transcribed by any server that implements OpenAI's `POST /audio/transcriptions` API: OpenAI (Whisper), Groq, or one you host (faster-whisper-server, LocalAI). Anthropic has no speech-to-text API, so this is separate from `AI_API_KEY`.

Set `TRANSCRIBE_API_KEY` (and optionally `TRANSCRIBE_BASE_URL` / `TRANSCRIBE_MODEL`) to switch it on; "Upload recording" then appears in the new-meeting dialog. A self-hosted server that needs no key only needs `TRANSCRIBE_BASE_URL`. Formats: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, flac, up to `MAX_AUDIO_MB` (default 25, OpenAI's limit).

How it behaves:
- Transcription runs in the background job queue and is retried once if the service is busy or unreachable. If it ends up failing (bad key, corrupted audio, no speech detected) the meeting shows why.
- A recording costs `TRANSCRIBE_CREDITS` AI requests (default 5), charged up front and **refunded if transcription fails**.
- **The recording is deleted as soon as it has been transcribed** (or has finally failed); only the transcript is kept. Voice recordings never sit in storage.
- Recordings have **no speaker labels**, so action items spoken as "I'll write the notes" or "let's schedule a follow-up" arrive unassigned for the reviewer to assign before approving.
- If you put nginx or another proxy in front, allow request bodies at least as large as `MAX_AUDIO_MB` (the bundled nginx config allows 30 MB).

## Social sign-in (Google and GitHub)

People can sign in or sign up with "Continue with Google" / "Continue with GitHub". A provider appears on the sign-in page only when its credentials are set.

1. **Google:** in Google Cloud Console create an OAuth client of type *Web application*. **GitHub:** create an OAuth App (Settings → Developer settings).
2. Set the redirect / callback URL to `<your app's public URL>/api/auth/oauth/google/callback` (or `.../github/callback`). Locally that is `http://localhost:5173/api/auth/oauth/google/callback`.
3. Set `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET` (and/or the GitHub pair). If the public address differs from the first `CLIENT_URL`, also set `OAUTH_REDIRECT_BASE`.

How it works: the standard authorization-code flow with PKCE, and a `state` value tied to the browser by a short-lived signed cookie. The server then sets the normal session cookie and redirects into the app, so no token ever appears in a URL.

Account rules, which are deliberate:
- A brand-new email creates an account and a workspace, and any pending invitations are accepted. The provider must report the email as **verified**, or sign-in is refused.
- The same provider account always returns to the same user, even if its email later changes.
- **An existing password account is never signed in by a matching Google or GitHub email unless its address has been confirmed**, because someone could have registered the address first. That person signs in with their password and connects the provider under Settings → Account → Connected accounts (or confirms their email first, after which it links automatically). See *Email and address verification* above.
- Accounts created through a provider have no password until the user sets one ("Email me a link to set a password" in Settings). A user cannot disconnect their last way to sign in.

Not included: other providers (the two are defined in `server/src/services/auth/oauth.ts` and adding another is a small entry there) and Apple/Microsoft enterprise SSO.

## Payments (Stripe)

Paid plans use Stripe Checkout for sign-up, the Stripe Billing Portal for cards, invoices and cancelling, and webhooks to decide what plan a workspace is on. The plan only ever changes because Stripe says so.

1. In Stripe, create two recurring **monthly Prices**, one for Pro and one for Business. The amounts live in Stripe; `priceMonthly` in `server/src/config/plans.ts` is only what the pricing cards display, so keep them in step.
2. Turn on the customer portal (Settings → Billing → Customer portal).
3. Add a webhook endpoint `https://<your-host>/api/billing/webhook` listening for `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed` and `invoice.payment_failed`.
4. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` and `STRIPE_PRICE_BUSINESS`. The server refuses to start with a key but without the rest.

For local development use the Stripe CLI: `stripe listen --forward-to localhost:4000/api/billing/webhook` prints the `whsec_...` secret to use.

How it behaves: choosing Free cancels at the end of the paid period; switching between paid plans is prorated; a failed payment keeps the plan while Stripe retries and warns the workspace owners and admins; when Stripe gives up (`unpaid` or `canceled`) the workspace drops to Free. Downgrades that the workspace's current members or projects don't fit are refused. Each webhook re-reads the subscription from Stripe, so duplicate or out-of-order deliveries can't leave a workspace on the wrong plan.

**Without Stripe keys** plan changes are simulated (instant, free): fine for development and demos, but **refused in production** unless `ALLOW_SIMULATED_BILLING=true`, so a misconfigured deployment can't hand out paid plans. Workspaces upgraded in demo mode keep their plan when you later enable Stripe but have no subscription; nothing reconciles them, so reset those first.

Not included: tax/VAT collection, per-seat pricing, and annual plans.

## Configuration

See `.env.example`. `JWT_SECRET` and `MONGODB_URI` are required in production. Keep real secrets out of source control.

## Known gaps

Recordings are transcribed without identifying who is speaking, and there is no in-browser recording (upload only).
