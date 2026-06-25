# OpenVPM Cloud Production Runbook

OpenVPM has two operating modes:

- **Self-host / OSS:** leave `HOSTED_BILLING_ENABLED` unset. The full product is unlocked, usage metering is disabled, and Stripe subscription envs are optional.
- **OpenVPM Cloud:** set `HOSTED_BILLING_ENABLED=true`. Hosted billing, trials, read-only lapsed state, usage metering, and Stripe subscription management are active.

This boundary is intentional. Do not add hosted-only requirements to the self-host path.

## Public Website Flow

`openvpm.com` should route clinics clearly:

- `Start Cloud Trial` -> `${NEXT_PUBLIC_APP_URL}/register?intent=cloud`
- `Try the Live Demo` -> `${NEXT_PUBLIC_DEMO_URL}/login`
- `Self-host OpenVPM` -> `/install` and GitHub

Cloud signup creates a practice, a primary location, the owner admin user, default configuration, and hosted trial/demo data. Hosted accounts must verify email before login.

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
pnpm db:rls
```

That applies Postgres Row-Level Security policies from `packages/db/rls/enable-rls.sql`. App-layer filters and RLS work together: normal queries filter by `practiceId`, and RLS rejects cross-practice reads/writes if a bug misses a filter.

## Required Hosted Env

Set these on the hosted app deployment:

```env
HOSTED_BILLING_ENABLED=true
NEXTAUTH_URL=https://app.openvpm.com
NEXT_PUBLIC_APP_URL=https://app.openvpm.com
NEXTAUTH_SECRET=...
DATABASE_URL=...

STRIPE_SECRET_KEY=...
STRIPE_SUBSCRIPTION_WEBHOOK_SECRET=...
STRIPE_PRICE_CLOUD_LOCATION=...
STRIPE_PRICE_CLOUD_USER=...
STRIPE_PRICE_SMS_OVERAGE=...
STRIPE_PRICE_AI_OVERAGE=...

S3_ENDPOINT=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_REGION=...

RESEND_API_KEY=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
ANTHROPIC_API_KEY=...
OPS_ALERT_WEBHOOK_URL=...
CRON_SECRET=...
PLATFORM_ADMIN_EMAILS=...
```

`STRIPE_PRICE_CLOUD` is legacy-only. It must not be used for new checkout.

For local or staging signup tests without real email delivery, set `OPENVPM_EXPOSE_AUTH_LINKS=true`. This exposes the verification link after signup so the full flow can be clicked through. Do not enable it in production.

## Stripe Setup

Create one Stripe product for OpenVPM Cloud with these recurring monthly prices:

- Cloud location: `$99/month`, env `STRIPE_PRICE_CLOUD_LOCATION` (flat per active location, unlimited staff).
- `$0/month` seat price, env `STRIPE_PRICE_CLOUD_USER` — the flat-model seat item. It is not added to new checkout, but the env must be set (the plan only shows as purchasable, and `/api/health` only passes, when both location and user prices are present).
- AI overage metered price, env `STRIPE_PRICE_AI_OVERAGE`.
- SMS overage metered price, env `STRIPE_PRICE_SMS_OVERAGE`.

`STRIPE_PRICE_CLOUD` (legacy single price) is only kept for mapping existing subscriptions; new checkout never uses it.

### Included allowance + metered overage (Stripe Billing Meters)

The Cloud plan includes **1,000 AI actions + 1,000 SMS per month**, then bills **$0.05/AI action** and **$0.03/SMS**. This is modeled with Stripe Billing Meters (the legacy usage-records API is gone as of API version 2025-03-31.basil):

1. Create two meters — `openvpm_ai_run` and `openvpm_sms` — with sum aggregation, value payload key `value`, and customer mapping by `stripe_customer_id`. The event names must match `lib/billing/stripe-meters.ts`.
2. Create a graduated metered price per meter with the included allowance as the $0 first tier: tiers `[{ up_to: 1000, unit_amount: 0 }, { up_to: inf, unit_amount: 5 }]` for AI (cents) and `… unit_amount: 3` for SMS, each with `recurring.usage_type=metered` and `recurring.meter=<meter id>`. Wire to `STRIPE_PRICE_AI_OVERAGE` / `STRIPE_PRICE_SMS_OVERAGE`.

Checkout creates one subscription: a per-location licensed item (quantity = active non-deleted locations, kept current by quantity sync) plus the two quantity-less metered items. `recordUsage()` writes the local `usage_records` row (display/reconcile source of truth) and, once the practice has a Stripe customer, reports a meter event so Stripe bills overage automatically. Pre-checkout no-card trial usage has no customer and stays free. Leaving the overage price envs unset keeps usage recorded but unbilled.

Webhook endpoint:

```text
https://app.openvpm.com/api/webhooks/stripe-subscription
```

Subscribe to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

## Health Check

Use:

```text
GET https://app.openvpm.com/api/health
```

It checks database connectivity and required hosted configuration for auth, Stripe billing, storage, email, SMS, AI, and ops hooks. It never returns secret values.

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

Demo login displays one-click role buttons. Demo should not use production Stripe, Twilio, or email credentials.

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
