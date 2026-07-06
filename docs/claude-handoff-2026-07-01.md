# Claude Handoff - OpenVPM Production Readiness - 2026-07-01

## Short Message To Tag Claude

Claude, please pick up OpenVPM production readiness from branch
`feat/sms-provider-abstraction` in `/Users/evan/Documents/pims`. Do not use
`main`, do not print secret values, and treat the current dirty worktree as
intentional production-readiness work. Start by reading
`docs/readiness-report-2026-07-01.md`, then continue the external-provider
setup and fresh-clinic mock launch flow described in the handoff below.

## Full Handoff Prompt

You are helping get OpenVPM production-ready in `/Users/evan/Documents/pims`.
The user wants to reach the same level Eddie reached after cloning the repo and
walking through production readiness from real practice feedback.

Important rules:

- Do not print secret values. Only report presence, missing, or status.
- Do not work from `main`.
- Start from branch `feat/sms-provider-abstraction`.
- Do not use destructive git commands.
- The worktree is expected to be dirty with production-readiness changes.
- Preserve unrelated user changes.
- Use `/Users/evan/Documents/pims`, not another checkout, unless the user
  explicitly redirects you.

First commands:

```sh
cd /Users/evan/Documents/pims
git branch --show-current
git status --short
git fetch origin feat/sms-provider-abstraction
git status --short
```

If the branch is not `feat/sms-provider-abstraction`, stop and ask before doing
anything that could affect `main`.

## Required Context To Read First

Read these files before making changes:

- `docs/PRODUCTION_PROGRESS.md`
- `docs/hosted-cloud-production.md`
- `docs/readiness-report-2026-07-01.md`
- `README.md`
- `docs/security/row-level-security.md`
- `.env.example`
- `docker/docker-compose.yml`
- `playwright.config.ts`
- `e2e/demo-screenshots.spec.ts`
- `e2e/registration-flow.spec.ts`
- `e2e/multi-clinic-launch-readiness.spec.ts`

Also verify whether a roadmap file exists. The readiness report references
`LAUNCH-ROADMAP.md`, but it was not visible through tracked-file search during
handoff prep. If Eddie/practice-feedback notes are not already captured in a
tracked roadmap doc, create or update an appropriate tracked roadmap file under
`docs/`.

## Current Proven State

As of this handoff:

- Correct branch was verified: `feat/sms-provider-abstraction`.
- Docker Desktop was healthy.
- Local Postgres and MinIO were up.
- App was running locally at `http://localhost:3003`.
- DB migration, RLS checks, typecheck, unit tests, auth/registration E2E, and
  multi-clinic launch-readiness E2E passed.
- Full unit suite passed: 217 files, 1918 tests.
- Typecheck passed.
- Multi-clinic E2E passed:

```sh
set -a; source .env; set +a
PLAYWRIGHT_BASE_URL=http://localhost:3003 \
  pnpm exec playwright test e2e/multi-clinic-launch-readiness.spec.ts \
  --reporter=line --workers=1
```

- Demo clinics were dogfooded locally:
  - Neighborhood Veterinary: seeded demo clinic.
  - Pine Hollow Veterinary: active Cloud, dummy active Stripe Connect account.
  - Cedar & Sage Animal Clinic: active Cloud, Stripe Connect setup required.
- Browser proof confirmed Pine-created client/patient/invoice did not appear in
  Cedar.
- Pricing was updated to `$79/location/month`, unlimited staff.
- Stripe Connect Express payment-account abstraction was added so clinics can
  bill their own clients through clinic-owned payment accounts.

## Current Worktree To Expect

Expect modified files across app, DB, docs, tests, and E2E. Known untracked
paths from the prior pass included:

- `apps/web/app/api/webhooks/stripe-connect/`
- `apps/web/lib/billing/__tests__/payment-accounts.test.ts`
- `apps/web/lib/billing/payment-accounts.ts`
- `docs/readiness-report-2026-07-01.md`
- `e2e/multi-clinic-launch-readiness.spec.ts`
- `packages/db/drizzle/0025_practice_payment_accounts.sql`

Do not delete or revert these unless the user explicitly instructs you to.

## User Needs List

The user asked for a simple list of what they need to provide and where to get
it. Continue from this list.

### 1. Eddie Call Notes

Needed so the roadmap reflects actual practice feedback.

Ask the user for one of:

- Granola meeting title/time.
- Exported notes dropped into `docs/eddie-practice-feedback-2026-07-01.md`.
- Zoom/Google Doc/Slack/file path containing the notes.

Once available, summarize into a tracked roadmap doc and update the readiness
report with any launch-critical requirements.

### 2. Stripe Billing And Stripe Connect

Stripe Connect is the feature needed for OpenVPM to set up billing on behalf of
clinics so clinics can collect client invoice payments into their own Stripe
accounts.

Needed env/status:

```env
STRIPE_SECRET_KEY=
STRIPE_PRICE_CLOUD_LOCATION=
STRIPE_WEBHOOK_SECRET=
STRIPE_CONNECT_WEBHOOK_SECRET=
STRIPE_SUBSCRIPTION_WEBHOOK_SECRET=
STRIPE_TAX_ENABLED=
STRIPE_CONNECT_APPLICATION_FEE_BPS=
```

Where the user gets it:

- Stripe Dashboard -> Developers -> API keys for `STRIPE_SECRET_KEY`.
- Stripe Dashboard -> Product catalog -> create/confirm "OpenVPM Cloud" at
  `$79/location/month`; copy the price ID to `STRIPE_PRICE_CLOUD_LOCATION`.
- Stripe Dashboard -> Developers -> Webhooks for the webhook signing secrets.
- Stripe Dashboard -> Connect for enabling Connect/Express accounts.

Required webhook endpoints:

```text
<APP_URL>/api/webhooks/stripe
<APP_URL>/api/webhooks/stripe-connect
<APP_URL>/api/webhooks/stripe-subscription
```

Decisions needed:

- Test mode first or live mode.
- Platform application fee, in basis points. Recommend `0` until decided.
- Stripe Tax on or off. Recommend `false` until tax behavior is confirmed.

### 3. Resend Email

Needed env/status:

```env
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
EMAIL_SUPPORT_ADDRESS=
EMAIL_COMPANY_ADDRESS=
```

Where the user gets it:

- Resend Dashboard -> API Keys for `RESEND_API_KEY`.
- Resend Dashboard -> Webhooks for `RESEND_WEBHOOK_SECRET`.
- Verified sending domain and support/company sender addresses.

Required webhook endpoint:

```text
<APP_URL>/api/webhooks/resend
```

### 4. SMS Provider

Telnyx is the current hosted default path.

Needed env/status for Telnyx:

```env
TELNYX_API_KEY=
TELNYX_MESSAGING_PROFILE_ID=
TELNYX_PUBLIC_KEY=
TELNYX_FROM_NUMBER=
```

Where the user gets it:

- Telnyx Mission Control -> API Keys for `TELNYX_API_KEY`.
- Telnyx -> Messaging -> Messaging Profiles for profile ID.
- Buy/assign a messaging-enabled number for `TELNYX_FROM_NUMBER`.
- Telnyx public key for signed webhook verification.

Required webhook endpoint:

```text
<APP_URL>/api/webhooks/telnyx
```

Twilio is also supported if the user chooses it instead:

```env
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_MESSAGING_SERVICE_SID=
```

### 5. Object Storage

Needed env/status:

```env
S3_ENDPOINT=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_BUCKET=
S3_REGION=
```

Where the user gets it:

- AWS S3, Cloudflare R2, or another S3-compatible provider.
- Create a private bucket.
- Create read/write credentials scoped to that bucket.

### 6. AI Provider

Current default expects Claude unless changed.

Claude:

```env
ANTHROPIC_API_KEY=
```

Gemini:

```env
GOOGLE_API_KEY=
# or
GOOGLE_GENERATIVE_AI_API_KEY=
```

Ask the user to decide Claude vs Gemini and provide the matching key through a
secure local env file or secure note, not pasted in chat.

### 7. Ops, URLs, And Production Database

Needed env/status:

```env
NEXTAUTH_URL=
NEXT_PUBLIC_APP_URL=
NEXTAUTH_SECRET=
DATABASE_URL=
PLATFORM_ADMIN_EMAILS=
CRON_SECRET=
OPS_ALERT_WEBHOOK_URL=
```

Also needed:

- Final production or staging HTTPS URL.
- Hosted Postgres connection details.
- Least-privilege app DB role for runtime.
- Owner/admin DB connection only for migrations, if needed.
- Heartbeat monitor URLs for reminders, backup, usage-reconcile,
  billing-lifecycle, wellness-billing, rate-limit-cleanup, and auth-cleanup.

You can generate `NEXTAUTH_SECRET` and `CRON_SECRET` locally if the user asks.

## What You Can Take Over

Once the user provides the missing keys/files/decisions, take over:

- Verify env files are gitignored before reading presence.
- Inspect env presence only; never print values.
- Wire env names into local/staging deployment.
- Bring up local Postgres/MinIO if needed:

```sh
docker compose -f docker/docker-compose.yml up -d postgres minio minio-bootstrap
```

- Run DB migration/seed/RLS:

```sh
pnpm db:migrate
pnpm db:seed
pnpm db:rls
pnpm db:rls:test
```

- Run checks:

```sh
pnpm type-check
pnpm test
pnpm exec playwright test e2e/registration-flow.spec.ts --reporter=line --workers=1
PLAYWRIGHT_BASE_URL=http://localhost:3003 \
  pnpm exec playwright test e2e/multi-clinic-launch-readiness.spec.ts \
  --reporter=line --workers=1
```

- Start or reuse the app server, then browser-dogfood a fresh clinic.
- Update `docs/readiness-report-2026-07-01.md` with the final evidence.
- Add Eddie/practice-feedback notes to a tracked roadmap doc.

## Fresh Clinic Mock Flow To Run Next

Run this once external provider config is present, ideally in Stripe test mode:

1. Register a new clinic through the hosted signup UI.
2. Complete Stripe test checkout for the `$79/location/month` Cloud plan.
3. Verify the clinic appears active/subscribed in-app.
4. Complete or attempt Stripe Connect Express onboarding for clinic-owned client
   payments.
5. Create staff/location setup as needed.
6. Create a client.
7. Create a patient.
8. Schedule an appointment.
9. Create a SOAP/medical note if the app flow supports it cleanly.
10. Create an invoice.
11. Attempt client invoice card checkout/payment through Stripe test mode.
12. Verify payment/account status returns correctly through webhooks.
13. Verify email send/webhook behavior if Resend is configured.
14. Verify SMS send/inbound/opt-out behavior if Telnyx or Twilio is configured.
15. Verify uploaded files and backup/export round-trip if object storage is
    configured.
16. Log into a second clinic and verify no cross-clinic data leakage.

Classify any remaining blockers into:

- Must ship before paid clinic use.
- Gated v1 limitation.
- External account/decision.
- Runtime/browser proof.
- Nice-to-have parity.

## Suggested Final User Update

When done, give the user a concise status report:

- Branch and worktree status.
- What providers are configured.
- What checks passed.
- What the fresh-clinic mock proved.
- What remains blocked by missing accounts/keys/decisions.
- Exact next user action, if any.
