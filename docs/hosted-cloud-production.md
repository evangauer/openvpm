# OpenVPM Cloud Production Runbook

OpenVPM has two operating modes:

- **Self-host / OSS:** leave `HOSTED_BILLING_ENABLED` unset. Hosted billing gates and usage metering are disabled, and Stripe subscription envs are optional.
- **OpenVPM Cloud:** set `HOSTED_BILLING_ENABLED=true`. Hosted billing, trials, read-only lapsed state, usage metering, and Stripe subscription management are active.

This boundary is intentional. Do not add hosted-only requirements to the self-host path.

## Public Website Flow

`openvpm.com` should route clinics clearly:

- `Start Cloud Trial` -> `${NEXT_PUBLIC_APP_URL}/register?intent=cloud`
- `Try the Live Demo` -> `${NEXT_PUBLIC_DEMO_URL}/login`
- `Self-host OpenVPM` -> `/install` and GitHub

Cloud signup creates a practice, a primary location, the owner admin user, default configuration, and hosted first-run demo data. By default, signup grants a 14-day trial immediately with no card and the clinic lands in the product (adding a card converts to paid); email verification is a soft prompt, not a login gate. Set `HOSTED_NO_CARD_TRIAL=false` to reinstate the legacy card-collected checkout wall at signup.

First run greets the new admin (and every invited staff member, once) with the value-first welcome: Polaroid guide cards that walk a workflow on the seeded demo data before any setup is asked. The Make-it-yours wizard is offered right after the first completed guide and from the welcome's "Set up my clinic instead" link. Rollback lever: `NEXT_PUBLIC_FIRST_RUN_MODE=wizard` restores the auto-opening wizard exactly. `NEXT_PUBLIC_WELCOME_VARIANT=imagery` switches the cards to the layered-art look (reviewers can flip live with `?welcomeVariant=`).

Set the marketing deployment envs to:

```env
NEXT_PUBLIC_APP_URL=https://app.openvpm.com
NEXT_PUBLIC_DEMO_URL=https://demo.openvpm.com
```

## Tenant Database Model

OpenVPM Cloud uses one hosted Postgres database cluster, not one physical database per clinic. A fresh clinic never has to create or configure a database.

On signup, the app creates:

- A `practices` row for the clinic tenant
- A primary `locations` row
- The owner `users` row with admin role
- Default appointment types, rooms, and services
- Hosted trial metadata
- Hosted demo clients, patients, and appointments for first-run exploration

Every tenant-scoped table stores `practice_id`. Authenticated app requests run through `withTenant()`, which sets `app.current_practice_id` for that request. Hosted production should use the least-privilege `openpims_app` database role and run:

```sh
pnpm db:migrate
OPENPIMS_APP_DB_PASSWORD='<strong-password>' pnpm db:rls
OPENPIMS_APP_DB_PASSWORD='<same-password>' pnpm db:rls:test
```

`pnpm db:migrate` applies the committed Drizzle migrations from `packages/db/drizzle`. Hosted production should not use `pnpm db:push`; `db:push` is reserved for disposable local/demo databases where schema drift is acceptable. `pnpm db:rls` then applies Postgres Row-Level Security policies from `packages/db/rls/enable-rls.sql`. App-layer filters and RLS work together: normal queries filter by `practiceId`, and RLS rejects cross-practice reads/writes if a bug misses a filter.
The RLS scripts trim `OPENPIMS_APP_DB_PASSWORD` and reuse it for live verification,
so whitespace-only setup values fail closed and `db:rls:test` connects with the
same app-role credential you will put in hosted `DATABASE_URL`.

## Required Hosted Env

Set these on the hosted app deployment:

```env
HOSTED_BILLING_ENABLED=true
NEXTAUTH_URL=https://app.openvpm.com
NEXT_PUBLIC_APP_URL=https://app.openvpm.com
NEXTAUTH_SECRET=...
DATABASE_URL=...

STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
STRIPE_CONNECT_WEBHOOK_SECRET=...
# Optional; leave unset/0 for v1 if OpenVPM does not take a fee on clinic client payments.
STRIPE_CONNECT_APPLICATION_FEE_BPS=
STRIPE_SUBSCRIPTION_WEBHOOK_SECRET=...
STRIPE_PRICE_CLOUD_LOCATION=...
STRIPE_TAX_ENABLED=true

S3_ENDPOINT=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_REGION=...

RESEND_API_KEY=...
RESEND_WEBHOOK_SECRET=...
EMAIL_SUPPORT_ADDRESS=support@openvpm.com
EMAIL_COMPANY_ADDRESS=...
MESSAGING_PROVIDER=telnyx
TELNYX_API_KEY=...
TELNYX_PUBLIC_KEY=...
MESSAGING_REGISTRATION_ENCRYPTION_KEY=... # openssl rand -base64 32
MESSAGING_PROVISIONING_ENABLED=false
MESSAGING_PROVISIONING_PRACTICE_IDS= # comma-separated approved pilot practice UUIDs
MESSAGING_SENDING_ENABLED=false
MESSAGING_SENDING_PRACTICE_IDS= # comma-separated approved pilot practice UUIDs
MESSAGING_SENDING_LOCATION_IDS= # comma-separated approved pilot location UUIDs
AI_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=...
OPS_ALERT_WEBHOOK_URL=...
CRON_SECRET=...
CRON_HEARTBEAT_URL=...
PLATFORM_ADMIN_EMAILS=...
```

`STRIPE_PRICE_CLOUD_USER` and `STRIPE_PRICE_CLOUD` are legacy-only. They must not be used for new checkout or required hosted readiness.

Telnyx is the hosted SMS default. `TELNYX_PUBLIC_KEY` is required for the
public webhook to verify inbound SMS and delivery-status callbacks. For a
hosted Telnyx deployment, set a dedicated 32-byte
`MESSAGING_REGISTRATION_ENCRYPTION_KEY` before collecting clinic A2P details.
Normal clinic sends use the per-location profile and number stored after the
location completes texting setup. `TELNYX_MESSAGING_PROFILE_ID` and
`TELNYX_FROM_NUMBER` are optional platform fallback sender values for legacy or
development calls that do not specify a location; do not point them at an
individual clinic merely to satisfy readiness checks.
Keep `MESSAGING_PROVISIONING_ENABLED=false` until the Telnyx account, webhook,
operator queue, and budget controls have been verified; changing it to `true`
opens the explicitly confirmed fee-bearing provisioning actions. Hosted
number orders additionally require the clinic's practice UUID in
`MESSAGING_PROVISIONING_PRACTICE_IDS`, so a controlled pilot does not expose
purchases to every clinic admin. New OpenVPM-created messaging profiles enforce
a `$10.00` daily Telnyx spend limit and smart encoding; review that cap before
expanding beyond a design-partner pilot.

Outbound sending has a separate, default-off launch interlock. Keep
`MESSAGING_SENDING_ENABLED=false` and both sending allowlists empty until one
Telnyx location has carrier-active registration, its database sender is enabled,
and the clinic has passed pilot review. A hosted send requires the practice UUID
in `MESSAGING_SENDING_PRACTICE_IDS` and the exact location UUID in
`MESSAGING_SENDING_LOCATION_IDS`; the hosted pilot permits only one enabled
location per practice. Missing, ambiguous, Twilio, inactive, or partially
configured state makes no provider call. These three variables are hosted-only
and do not gate intentional self-host messaging configuration. Arbitrary hosted
test destinations remain disabled; validate through a current, consented client
workflow after approval.

For a Twilio fallback deployment, set `MESSAGING_PROVIDER=twilio` and provide
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` instead of
the Telnyx send envs.

Self-hosted external SMS must also set `MESSAGING_REGISTERED_DISPLAY_NAME` to
the exact clinic name approved on that provider's active campaign. OpenVPM
snapshots that identity on every durable send attempt and adds the canonical
STOP/HELP footer. Hosted sends do not use this override: they require an active,
provider-matching `messaging_registrations` row. Console-only local testing may
use the practice name because it never contacts a carrier.

Hosted AI defaults to Claude and requires `ANTHROPIC_API_KEY`. If you choose a
Gemini `AI_MODEL`, set either `GOOGLE_API_KEY` or the legacy
`GOOGLE_GENERATIVE_AI_API_KEY`; `/api/health` requires one matching provider
credential, not both providers.

For local or staging signup tests without real email delivery, set `OPENVPM_EXPOSE_AUTH_LINKS=true`. This exposes the verification link after signup so the full flow can be clicked through. Do not enable it in production.

## Email Setup

Resend sends transactional email and posts delivery lifecycle callbacks back to OpenVPM so bounces, spam complaints, and provider suppressions can fail closed before future client email sends.

`EMAIL_SUPPORT_ADDRESS` is used as lifecycle email Reply-To and footer contact
address. `EMAIL_COMPANY_ADDRESS` is rendered in hosted email footers. Both gate
hosted readiness so production emails do not fall back to local/dev defaults.

Webhook endpoint:

```text
https://app.openvpm.com/api/webhooks/resend
```

Subscribe to:

- `email.delivered`
- `email.bounced`
- `email.complained`
- `email.failed`
- `email.suppressed`

Store this endpoint secret as `RESEND_WEBHOOK_SECRET`.

## Stripe Setup

Create one Stripe product for OpenVPM Cloud with these recurring monthly prices:

- Cloud location: `$79/month`, env `STRIPE_PRICE_CLOUD_LOCATION` (flat per active location, unlimited staff).
- Legacy `$0/month` seat price, env `STRIPE_PRICE_CLOUD_USER` — kept only so existing split-price subscriptions can still map to Cloud during webhook and quantity-sync processing. It is not added to new checkout and is not required by `/api/health`.
- AI overage metered price, env `STRIPE_PRICE_AI_OVERAGE`.
- SMS overage metered price, env `STRIPE_PRICE_SMS_OVERAGE`.

`STRIPE_PRICE_CLOUD` (legacy single price) is only kept for mapping existing subscriptions; new checkout never uses it. Set `STRIPE_PRICE_AI_OVERAGE` and `STRIPE_PRICE_SMS_OVERAGE` when overage billing should be active; if either is omitted, usage is still recorded locally and reconciliation can report it, but Stripe will not bill that overage line.

### Included allowance + metered overage (Stripe Billing Meters)

The Cloud plan includes **1,000 AI actions + 1,000 SMS per month**, then bills **$0.05/AI action** and **$0.03/SMS**. This is modeled with Stripe Billing Meters (the legacy usage-records API is gone as of API version 2025-03-31.basil):

1. Create two meters — `openvpm_ai_run` and `openvpm_sms` — with sum aggregation, value payload key `value`, and customer mapping by `stripe_customer_id`. The event names must match `lib/billing/stripe-meters.ts`.
2. Create a graduated metered price per meter with the included allowance as the $0 first tier: tiers `[{ up_to: 1000, unit_amount: 0 }, { up_to: inf, unit_amount: 5 }]` for AI (cents) and `… unit_amount: 3` for SMS, each with `recurring.usage_type=metered` and `recurring.meter=<meter id>`. Wire to `STRIPE_PRICE_AI_OVERAGE` / `STRIPE_PRICE_SMS_OVERAGE`.

Checkout creates one subscription: a per-location licensed item (quantity = active non-deleted locations, kept current by quantity sync) plus any configured quantity-less metered items. `recordUsage()` writes the local `usage_records` row (display/reconcile source of truth) and, once the practice has a Stripe customer, reports a meter event so Stripe bills overage automatically. Before the conversion Stripe checkout completes, there is no customer to meter against, so any pre-checkout usage stays local. Leaving the overage price envs unset keeps usage recorded but unbilled.

Stripe Tax gates hosted readiness. Complete Stripe Tax registrations and origin-address setup in Stripe, then set `STRIPE_TAX_ENABLED=true` so subscription checkout collects billing address/tax IDs and lets Stripe calculate tax on the Cloud subscription. Client invoice payments stay on OpenVPM's already-totaled invoice amounts and do not add Stripe Tax again.

Client invoice payment webhook endpoint:

```text
https://app.openvpm.com/api/webhooks/stripe
```

Subscribe to:

- `checkout.session.completed`

Store this endpoint secret as `STRIPE_WEBHOOK_SECRET`.

### Stripe Connect for clinic-owned client payments

OpenVPM Cloud uses Stripe Connect Express for clinics that want to bill pet
owners by card. This is separate from the OpenVPM Cloud subscription above:
Cloud subscription charges settle to OpenVPM, while client invoice payments are
created on the clinic's connected account after onboarding is complete.

Enable Connect in the platform Stripe account, then add the Connect webhook:

```text
https://app.openvpm.com/api/webhooks/stripe-connect
```

Subscribe to:

- `account.updated`
- `checkout.session.completed`

Store this endpoint secret as `STRIPE_CONNECT_WEBHOOK_SECRET`.

`STRIPE_CONNECT_APPLICATION_FEE_BPS` is optional and defaults to `0`. Leave it
unset for v1 if OpenVPM should not take a percentage fee from clinic client
payments.

Hosted subscription webhook endpoint:

```text
https://app.openvpm.com/api/webhooks/stripe-subscription
```

Subscribe to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

Store this endpoint secret as `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`.

`checkout.session.completed` is shared by the platform invoice and hosted
subscription endpoints. OpenVPM de-duplicates it per endpoint, so both webhook
endpoints must remain configured; each handler ignores sessions that belong to
the other billing surface.

## Health Check

Use:

```text
GET https://app.openvpm.com/api/health
```

It checks database connectivity and required hosted configuration for auth, Stripe billing, storage, email, AI, and ops hooks. It never returns secret values. SMS provider setup is reported as advisory until the active provider is provisioned.

Cron heartbeat/dead-man monitoring gates hosted readiness in `/api/health`: set
one global `CRON_HEARTBEAT_URL` to receive every cron completion as POST JSON, or
set job-specific URLs (`CRON_HEARTBEAT_REMINDERS_URL`,
`CRON_HEARTBEAT_BACKUP_URL`, `CRON_HEARTBEAT_USAGE_RECONCILE_URL`,
`CRON_HEARTBEAT_BILLING_LIFECYCLE_URL`,
`CRON_HEARTBEAT_WELLNESS_BILLING_URL`,
`CRON_HEARTBEAT_RATE_LIMIT_CLEANUP_URL`,
`CRON_HEARTBEAT_AUTH_CLEANUP_URL`,
`CRON_HEARTBEAT_ACTIVATION_DIGEST_URL`,
`CRON_HEARTBEAT_CONVERSION_RECONCILE_URL`,
`CRON_HEARTBEAT_PRESCRIPTION_EXPIRY_URL`) when your external monitor expects one URL
per scheduled job. URL templates may include `{job}` and `{status}` tokens.

## Demo Mode

For the public demo deployment:

```env
NEXT_PUBLIC_DEMO_MODE=true
HOSTED_BILLING_ENABLED=
```

Seed demo data with:

```sh
pnpm db:push
pnpm db:seed
```

Demo login displays one-click role buttons. Demo should not use production Stripe, SMS, or email credentials.

## Public Repo Hygiene

Safe in the public repo:

- OSS app code
- Hosted feature flags and generic billing integration
- Env variable names
- Public docs and self-host deployment instructions

Do not commit:

- Real env files or provider secrets
- Local `.codex/`, MCP config, Vercel metadata, screenshots, private launch docs
- Customer data, exports, logs, or production database snapshots

`.gitignore` already excludes the local/private files used by development and launch work.
