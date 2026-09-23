# Deploying a free demo (Render)

This deploys the app as a public link you can send people, at zero cost. It reuses the
same architecture that's already built and CI-tested in `docker-compose.yml` — an nginx
frontend proxying `/api` and `/socket.io` to a backend service — via the `render.yaml`
Blueprint at the repo root, so there's very little to configure by hand.

**What "free" means here:** the frontend (and, if it's idle, the backend) spins down after
~15 minutes with no traffic and takes ~30-50s to wake up on the next visit. Fine for
sharing a link with someone; not fine for anything that needs to always be instantly up
(see the note at the end for the paid alternative).

## 1. A place to put the data — MongoDB Atlas (free)

Render doesn't host MongoDB, so the database lives elsewhere. MongoDB Atlas's free tier
(M0, 512MB, no card required) is the standard choice:

1. Go to <https://www.mongodb.com/cloud/atlas/register> and create a free account.
2. Create a free **M0** cluster (any region is fine).
3. Under **Database Access**, add a database user with a username/password (autogenerate
   the password — you'll paste it into a connection string next, then never need to type
   it again).
4. Under **Network Access**, add `0.0.0.0/0` (allow access from anywhere) — Render's
   outbound IPs aren't static on the free tier, so this is the practical option for a demo.
5. Click **Connect** on your cluster → **Drivers** → copy the connection string. It looks
   like `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/`. Add a database name
   to the path, e.g. `.../ai-productivity?retryWrites=true&w=majority` — that full string
   is your `MONGODB_URI`.

## 2. Create the Blueprint on Render

1. Go to <https://dashboard.render.com/register> and sign up (GitHub sign-in is easiest
   since it can also grant repo access in the same step).
2. **New** → **Blueprint**, connect the `msaikumarr/mspace` GitHub repo. Render reads
   `render.yaml` and shows two services: `backend` (private) and `frontend` (public web).
   (Render's Blueprint YAML schema occasionally renames a field between versions — if the
   dashboard flags a field in `render.yaml` as invalid, it will name the exact field and
   the fix is usually a one-word rename; tell me the error and I'll fix it.)
3. Before it deploys, Render will prompt you to fill in every env var marked as a secret
   in `render.yaml`. Paste in:
   - `MONGODB_URI` — from step 1.
   - `JWT_SECRET` — any long random string (e.g. generate one with
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`,
     `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_GITHUB_CLIENT_ID`,
     `OAUTH_GITHUB_CLIENT_SECRET`, `SMTP_URL`, `TRANSCRIBE_API_KEY` — reuse the same values
     from your local `.env` if you want the deployed demo to have working payments/social
     login/email/transcription too. **Except** `STRIPE_WEBHOOK_SECRET` — leave that one
     blank for now, it needs a new value from step 4 below (the old one only works for the
     Stripe CLI forwarding to your laptop).
   - `CLIENT_URL` — also leave blank for now, filled in in step 3.
4. Click **Apply**. Render builds both Docker images and deploys them. First build takes a
   few minutes.

## 3. Wire the frontend URL back into the backend

Once `frontend` is deployed, Render shows its public URL, something like
`https://mspace-frontend.onrender.com`.

1. Open the `backend` service → **Environment** → set `CLIENT_URL` to that URL
   (no trailing slash) → save (this redeploys the backend).

That URL is now the one link you share with people.

## 4. If you carried over Stripe/OAuth/SMTP: point them at the new URL

Only needed if you filled those in in step 2 — skip this if you left them blank (the app
falls back to simulated billing / email-disabled / no social login, which is a perfectly
fine demo on its own).

- **Stripe webhook** — in the [Stripe dashboard](https://dashboard.stripe.com/test/webhooks),
  add an endpoint at `https://<your-frontend-url>/api/billing/webhook`, subscribed to
  `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed`. Copy its **Signing secret**
  (`whsec_...`) into `backend`'s `STRIPE_WEBHOOK_SECRET` env var on Render.
- **Google OAuth** — in [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
  edit your OAuth client's **Authorized redirect URIs**, add
  `https://<your-frontend-url>/api/auth/oauth/google/callback`.
- **GitHub OAuth** — in your [GitHub OAuth App settings](https://github.com/settings/developers),
  set **Authorization callback URL** to
  `https://<your-frontend-url>/api/auth/oauth/github/callback`.
- **SMTP (Mailtrap)** — no change needed, but remember Mailtrap's sandbox inbox only
  delivers to Mailtrap's own UI, never to real inboxes. Fine for showing the feature exists;
  not fine as the actual email for people who sign up. Swap in a real SMTP provider
  (e.g. Resend, Postmark, or Gmail SMTP) later if this demo needs to send real mail.

## 5. Verify

Visit `https://<your-frontend-url>/api/health` — should return
`{"success":true,"data":{"status":"ok",...}}` (may take 30-50s to respond on the very
first hit while the free instance wakes up). Then open the site itself and sign in.

## Later: making it "real" instead of a demo

When this needs to stay always-on and/or take real payments, the two changes are:
1. Upgrade `backend` and `frontend` from Render's free plan to **Starter** (~$7/mo each,
   no more spin-down) — one field (`plan: starter`) per service in `render.yaml`.
2. Switch Stripe and the OAuth apps from test/sandbox credentials to live ones, and use a
   real (non-sandbox) SMTP provider.
