# OpenVPM Launch Readiness Report - 2026-07-01

## Executive Status

OpenVPM is now substantially closer to production readiness on branch
`feat/sms-provider-abstraction`. Docker, Postgres, MinIO, migrations, RLS,
unit tests, targeted E2E, and browser dogfood all pass locally.

Verdict: ready for deeper controlled pilot/dogfood with dummy or friendly
clinics. Not ready for paid clinic production until hosted health is green and
external provider configuration is completed.

## What Was Proved

- Docker Desktop is healthy. Local services are up:
  - Postgres: healthy on `localhost:5432`
  - MinIO: up on `localhost:9000` and console on `localhost:9001`
- Database migration and RLS checks pass.
- Full unit suite passes: 217 files, 1918 tests.
- Demo Playwright route audit passes: dashboard, patients, clients, schedule,
  records, billing, inventory, inbox, whiteboard, controlled substances,
  reports, and settings all returned 200 with no browser errors.
- Registration E2E now matches the current hosted signup UI and passes.
- Hosted signup was browser-probed and reached `checkout.stripe.com` using
  Stripe test checkout.
- Multi-clinic local proof passes with tenant isolation at DB/RLS and UI levels.
- A repeatable Playwright launch-readiness spec now creates fresh dummy clinics
  each run, proves clinic-day writes, verifies Stripe Connect setup states, and
  confirms cross-clinic data does not leak through the UI.

## Multi-Clinic Dummy Environment

Seeded/proved clinics:

- Neighborhood Veterinary: existing seeded demo clinic.
- Pine Hollow Veterinary: active Cloud clinic with dummy active Stripe Connect
  payment account.
- Cedar & Sage Animal Clinic: active Cloud clinic with Stripe Connect setup
  required.

Final local counts:

- Pine Hollow Veterinary: 1 user, 4 clients, 4 patients, 2 appointments,
  2 invoices, client payment status active.
- Cedar & Sage Animal Clinic: 1 user, 3 clients, 3 patients, 2 appointments,
  1 invoice, client payment setup required.
- Neighborhood Veterinary: existing seeded demo clinic with 8 users,
  25 clients, 40 patients, 184 appointments, 14 invoices.

Tenant isolation proof:

- Pine RLS context saw only Pine rows and 1 payment account.
- Cedar RLS context saw only Cedar rows and 0 payment accounts.
- Unset tenant context saw 0 tenant rows.
- Browser-created Pine client/patient/invoice did not appear in Cedar UI.

## Clinic-Day Browser Proof

Browser-dogfooded:

- Login for Pine Hollow and Cedar & Sage.
- Dashboard, schedule, clients, patients, billing, records, inbox, reports,
  settings.
- Pine Hollow created a new client, patient, and invoice through the app UI.
- Cedar & Sage was re-opened after those writes and could not see Pine data.
- Settings > Plan & Billing showed:
  - Pine: client payment processing Ready, card payments Enabled, payouts
    Enabled.
  - Cedar: client payment processing Setup Needed, card payments Disabled,
    payouts Pending, Set up action visible.

Evidence files:

- Repeatable spec: `e2e/multi-clinic-launch-readiness.spec.ts`
- `test-results/launch-readiness/browser-summary.json`
- `test-results/launch-readiness/payment-settings-summary-loaded.json`
- `test-results/launch-readiness/clinic-day-mutation-summary.json`
- Screenshots under `test-results/launch-readiness/`

Repeatable command:

```sh
set -a; source .env; set +a
PLAYWRIGHT_BASE_URL=http://localhost:3003 \
  pnpm exec playwright test e2e/multi-clinic-launch-readiness.spec.ts \
  --reporter=line --workers=1
```

## Product/Code Changes Made In This Pass

- Added Stripe Connect Express payment-account abstraction so clinics can
  collect client invoice payments into their own Stripe accounts.
- Added `practice_payment_accounts` table, migration, RLS coverage, router
  procedures, webhook route/tests, and Settings UI for payment onboarding.
- Updated hosted Cloud pricing to $79/location/month with unlimited staff.
- Updated docs/examples/tests/email templates to match the $79 model.
- Updated Playwright config to support `PLAYWRIGHT_BASE_URL`, so E2E can run
  against non-3000 local ports.
- Updated registration E2E to current labels and hosted checkout behavior.
- Added a repeatable multi-clinic launch-readiness E2E that seeds unique clinics,
  logs into each clinic, exercises core screens, creates a client/patient/invoice
  in one clinic, verifies isolation in the other, and checks clinic-owned Stripe
  Connect payment setup states.
- Added Eddie/practice-feedback roadmap notes to local `LAUNCH-ROADMAP.md`
  for working roadmap context.

## Blockers By Category

### Must Ship Before Paid Clinic Use

- Hosted health must return green in production.
- Configure production HTTPS URLs:
  - `NEXTAUTH_URL`
  - `NEXT_PUBLIC_APP_URL`
- Complete Stripe Billing config:
  - `STRIPE_WEBHOOK_SECRET`
  - `STRIPE_CONNECT_WEBHOOK_SECRET`
  - verify `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`
  - verify `STRIPE_PRICE_CLOUD_LOCATION` points to the $79/location price
  - set `STRIPE_TAX_ENABLED=true` only after Stripe Tax/product tax behavior is
    confirmed.
- Configure object storage:
  - `S3_ENDPOINT`
  - `S3_ACCESS_KEY`
  - `S3_SECRET_KEY`
  - `S3_BUCKET`
  - `S3_REGION`
- Configure hosted email:
  - `RESEND_API_KEY`
  - `RESEND_WEBHOOK_SECRET`
  - `EMAIL_SUPPORT_ADDRESS`
  - `EMAIL_COMPANY_ADDRESS`
- Configure ops:
  - `CRON_SECRET`
  - `OPS_ALERT_WEBHOOK_URL`
  - heartbeat URLs for reminders, backup, usage-reconcile, billing-lifecycle,
    wellness-billing, rate-limit-cleanup, auth-cleanup.
- Production database must use the least-privilege app role with RLS enabled,
  not the owner role.

### External Account/Decision

- Stripe Connect Express must be enabled for the Stripe account.
- Decide platform application fee basis points for client invoice card payments:
  - `STRIPE_CONNECT_APPLICATION_FEE_BPS`
  - default is 0 if unset.
- Decide whether clinics are required to complete Connect onboarding before
  go-live or can launch with non-card/manual payment workflows.
- Decide active AI provider/model:
  - Gemini requires `GOOGLE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`.
  - Claude requires `ANTHROPIC_API_KEY`.
- Decide active SMS provider:
  - Telnyx path requires `TELNYX_API_KEY`, `TELNYX_MESSAGING_PROFILE_ID`,
    `TELNYX_PUBLIC_KEY`, and usually `TELNYX_FROM_NUMBER`.
  - Twilio path requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
    `TWILIO_PHONE_NUMBER`.

### Runtime/Browser Proof Still Needed

- Production deployment health check after real env is applied.
- Stripe webhook round-trip in deployed environment:
  - subscription checkout complete
  - client invoice payment checkout
  - Connect account update webhook
- Email round-trip:
  - verification email
  - welcome email
  - payment/failed-payment lifecycle email
  - Resend webhook handling
- SMS round-trip:
  - outbound reminder/send
  - inbound webhook
  - opt-out suppression.
- Storage round-trip:
  - upload
  - file retrieval
  - backup/export to object storage.

### Gated V1 Limitation

- Full PIMS replacement still depends on real clinic feedback around migration,
  reminders, billing edge cases, forms/signatures, and workflows.
- Current best launch posture is secondary/parallel PIMS or controlled pilot,
  then expand once clinic import, communications, and payment ops are proven
  with a real practice.

### Nice-To-Have Parity

- More onboarding polish for clinic-owned Stripe setup.
- More explicit status dashboards for provider readiness per clinic.
- More seeded clinic-day scenarios for labs, photos/files, SOAP, prescriptions,
  and reminders.

## What I Need From You

1. Stripe
   - Where: Stripe Dashboard.
   - Get/confirm:
     - Connect Express enabled.
     - Hosted price for Cloud is $79/location/month.
     - Webhook signing secrets for subscription, invoice/client payment, and
       Connect endpoints.
     - Stripe Tax decision and whether to enable `STRIPE_TAX_ENABLED`.
     - Platform application fee decision for clinic client payments.

2. Resend
   - Where: Resend Dashboard.
   - Get/create:
     - API key.
     - Webhook signing secret.
     - Verified sending domain/from/support/company addresses.

3. SMS provider
   - Where: Telnyx or Twilio dashboard.
   - For Telnyx, get:
     - Messaging profile ID.
     - Public key.
     - Sending number.
     - Confirm webhook URL can point to OpenVPM.

4. Object storage
   - Where: production S3-compatible provider.
   - Get:
     - Endpoint, region, bucket, access key, secret key.
     - Confirm CORS/object access policy for app uploads/downloads.

5. AI provider
   - Where: Google AI Studio/GCP or Anthropic Console.
   - Decide model/provider and provide the matching API key.

6. Ops
   - Where: hosting platform and alerting tool.
   - Provide:
     - Production HTTPS app URL.
     - Cron secret.
     - Alert webhook URL.
     - Heartbeat monitor URLs for each cron job.
     - Platform admin email list.

## What I Can Take Over Next

- Wire the remaining env names into the deployment without exposing values.
- Run production health after deployment.
- Configure and test Stripe webhooks/Connect flow end-to-end.
- Expand seeded multi-clinic proof to include SOAP notes, file upload, SMS, and
  email once external providers are configured.
- Turn `LAUNCH-ROADMAP.md` into tracked roadmap issues or docs once you decide
  what should be public versus private.

## Evening Pass Update - 2026-07-01

### Local Hosted-Mode Environment Wired

- `apps/web/.env.local` now carries a full hosted test configuration
  (values withheld): Stripe test key + `$79/location/month` price
  (`STRIPE_PRICE_CLOUD_LOCATION` now points to a new test-mode price at
  `unit_amount 7900`; the old test price was still $99), all three webhook
  secrets from the Stripe CLI forwarder, MinIO storage, `CRON_SECRET`,
  `OPENVPM_EXPOSE_AUTH_LINKS`, and support/company email addresses.
- `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` were fixed from `localhost:3000` to
  `localhost:3003` — they previously pointed at the wrong port, which broke
  checkout success redirects and Connect return URLs in local testing.
- Two `stripe listen` forwarders deliver platform events to
  `/api/webhooks/stripe-subscription` + `/api/webhooks/stripe`, and Connect
  events to `/api/webhooks/stripe-connect`.
- Local `/api/health` (hosted mode): database, hostedCore, hostedBilling,
  hostedStorage (bucket reachable), and hostedOps are green. Remaining local
  reds are environment-inherent or external: HTTPS app URLs, Stripe Tax,
  Resend key/webhook secret, AI provider key, Telnyx provisioning (advisory),
  ops alert webhook, cron heartbeat URLs.

### Fresh-Clinic Mock Launch Flow — PROVEN in Stripe test mode

New repeatable spec: `e2e/fresh-clinic-mock-launch.spec.ts`
(evidence: `test-results/fresh-clinic-launch/` — summary.json + 16 screenshots).

Proven end to end through the real UI + real Stripe test mode:

1. Hosted signup at `/register` → card-collected Stripe Checkout showing
   "$79.00/month, 14 days free, total due today $0.00" with both metered
   overage items attached.
2. Checkout completed with the 4242 test card (newer accordion-style Checkout
   with iframe card fields is handled).
3. `checkout.session.completed` webhook activated the practice:
   `billingStatus=trialing`, tier `cloud`, real `cus_`/`sub_` ids persisted.
4. Email verification gate exercised via a minted token (Resend not configured
   locally; production emails the same `/verify-email` link) → first login OK.
5. Clinic-day writes through the UI: client, patient, schedule appointment,
   SOAP note (Wellness Exam template apply), invoice.
6. Patient photo upload → object stored in MinIO under
   `<practiceId>/patient-photos/…` and rendered back in the patient page.
7. Backup cron (`/api/cron/backup` with `CRON_SECRET`) exported 25/25
   practices to `backups/<practiceId>/2026-07-01.json` in MinIO.
8. Tenant isolation re-proven: a second clinic sees none of the fresh
   clinic's client/patient/practice data.
9. Regression: `registration-flow` + `multi-clinic-launch-readiness` E2E pass.

### Blocked Externally (unchanged by code)

- **Stripe Connect is not enabled on the Stripe (sandbox) account.**
  `billing.createPaymentAccountOnboarding` fails with "You can only create new
  accounts if you've signed up for Connect" — enable at
  `dashboard.stripe.com/connect`. Until then, Connect Express onboarding and
  client invoice card payments (hosted mode requires an active connected
  account) cannot be exercised. The spec records the blocker and skips those
  two tests; they will run fully once Connect is enabled.
- Stripe Tax registration + `STRIPE_TAX_ENABLED` decision.
- Resend webhook secret (`RESEND_WEBHOOK_SECRET`) + support/company addresses
  in production.
- Telnyx: account still has 0 messaging profiles / 0 numbers (L2 verification
  + funding + A2P pending).
- AI provider decision (Claude `ANTHROPIC_API_KEY` vs Gemini `GOOGLE_API_KEY`).
- Ops alert webhook + cron heartbeat monitor URLs (one global
  `CRON_HEARTBEAT_URL` satisfies the health gate).

### Production Deployment Note

- `https://app.openvpm.com/api/health` currently returns `ok: true` — but that
  deployment runs the older `main` build. This branch's stricter health gates
  (HTTPS URL validation, Stripe Tax, Connect webhook secret, RLS role
  assertion, ops alerting, cron heartbeats) will report FAIL on prod after
  merge until the corresponding env/config is added.

### Pricing Mismatch To Resolve Before Go-Live

Three different prices are currently in play and need one decision:

- This branch (code, docs, emails, local Stripe test price): **$79/location/month**
- Production Stripe env (`app.openvpm.com`): still the **$99** price
- Marketing site (`openvpm.com`): displays **$79**

## Pricing Decision RESOLVED - 2026-07-03

Founding price is **$79/location/month** (unlimited staff). The earlier
$75/$79/$99 three-way conflict is closed:

- Code/docs/emails/tests repriced $75 → $79
  (`CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD = 79`).
- New $79 TEST Stripe price created on the Cloud product and wired to local
  `STRIPE_PRICE_CLOUD_LOCATION`.
- Marketing site (openvpm.com) already shows $79 — now consistent.
- REMAINING for go-live: create the matching $79 LIVE Stripe price and point
  the production `STRIPE_PRICE_CLOUD_LOCATION` (Vercel `openvpm-app`) at it
  (prod currently still on the $99 live price).
- Stripe Connect is now ENABLED on the account (Evan) — Connect Express
  onboarding + client card payment legs can now be exercised.
