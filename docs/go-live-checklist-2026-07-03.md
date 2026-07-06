# OpenVPM Go-Live Checklist — 2026-07-03

Founding price: **$79 / active location / month**, unlimited staff, 14-day
card-collected trial, metered AI/SMS overage beyond 1,000/1,000 included.

This is the path to flip `app.openvpm.com` to a paid, production-ready hosted
service. Items are ordered so that a green `/api/health` is achievable at the
end. `/api/health` in hosted mode is a HARD gate: every non-advisory check must
pass for it to return 200. Only `hostedSms` (Telnyx) is advisory/deferrable.

---

## A. Done in code (branch `feat/sms-provider-abstraction`)

- Repriced hosted Cloud $75 → **$79** across code, docs, emails, tests
  (`CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD = 79`). Full unit suite green
  (1,918 tests) + typecheck clean.
- $79 **TEST** Stripe price created on the Cloud product and wired locally.
- Fresh-clinic mock launch flow proven end-to-end in Stripe test mode at the
  new price (signup → $79 checkout → subscription webhook → verification →
  clinic-day writes → storage → isolation).
- Stripe **Connect is enabled** (verified at the API level).

---

## B. External actions needed from Evan (blockers, with exact locations)

These are dashboard/account actions only Evan can do. Each maps to a hosted
`/api/health` gate that must be green before paid go-live.

### B1. Stripe — create the LIVE $79 price
- Where: Stripe Dashboard (LIVE mode) → the existing "OpenVPM Cloud" product.
- Create a recurring **$79.00/month USD** price.
- Then set production env `STRIPE_PRICE_CLOUD_LOCATION` to that live price ID.
- Note: production is currently still pointed at the $99 live price. Do NOT
  delete the $99 price (existing subs may map to it); just repoint new checkout.
- Gate: `hostedBilling`.

### B2. Stripe — complete the Connect platform profile
- Where: dashboard.stripe.com/settings/connect/platform-profile
- Fill in the "responsibilities for managing losses" section (who is liable for
  negative balances / disputes on connected accounts).
- Why: Connect is enabled, but until this profile is complete, creating a
  connected account returns a platform-profile error, so clinic Connect Express
  onboarding and client card payments cannot start.
- Gate: not a health gate, but blocks the clinic-owned client-payment feature.

### B3. Stripe — create the two LIVE webhook endpoints
- Where: Stripe Dashboard (LIVE) → Developers → Webhooks.
- Endpoint 1 (client invoice payments): `https://app.openvpm.com/api/webhooks/stripe`
  → event `checkout.session.completed` → secret to env `STRIPE_WEBHOOK_SECRET`.
- Endpoint 2 (Connect): `https://app.openvpm.com/api/webhooks/stripe-connect`
  → events `account.updated`, `checkout.session.completed` → secret to env
  `STRIPE_CONNECT_WEBHOOK_SECRET`.
- (The subscription endpoint `…/api/webhooks/stripe-subscription` +
  `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` should already exist from earlier work —
  verify it's present.)
- Gate: `hostedBilling`.

### B4. Stripe Tax decision — HARD health gate
- The hosted readiness check requires `STRIPE_TAX_ENABLED=true`.
- To turn it on: complete Stripe Tax registrations + origin address in Stripe,
  then set `STRIPE_TAX_ENABLED=true` (checkout then collects billing address /
  tax IDs and lets Stripe calculate subscription tax).
- Decision: enable Stripe Tax before launch, OR tell me to relax this gate to
  advisory so we can launch without it (small code change, ~5 min).
- Gate: `hostedSubscriptionTax`.

### B5. Resend — webhook + sender identity
- Where: Resend Dashboard.
- Create a webhook → `https://app.openvpm.com/api/webhooks/resend` subscribed to
  `email.delivered/bounced/complained/failed/suppressed`; secret → env
  `RESEND_WEBHOOK_SECRET`.
- Set env `EMAIL_SUPPORT_ADDRESS` and `EMAIL_COMPANY_ADDRESS` (e.g.
  support@openvpm.com / your legal company address).
- Gate: `hostedEmail`.

### B6. Ops alerting + cron heartbeat — HARD health gates
- `OPS_ALERT_WEBHOOK_URL`: a Slack-style incoming webhook where background-job
  failures post. (Create a Slack incoming webhook or similar.)
- `CRON_HEARTBEAT_URL`: one dead-man-monitor URL that receives every cron
  completion as POST JSON (e.g. a Better Uptime / Healthchecks.io / cronitor
  check). One global URL satisfies the gate; per-job URLs optional.
- Gates: `hostedOpsAlerting`, `hostedCronHeartbeat`.

### B7. AI key sanity check
- Prod uses Gemini (`AI_MODEL=gemini-*`, `GOOGLE_API_KEY`). A prior note flagged
  the key value started `AQ.` not `AIza` — confirm it's a valid AI Studio key,
  or switch to Claude (`ANTHROPIC_API_KEY`).
- Gate: `hostedAi`.

### B8. (Deferred, advisory) Telnyx SMS
- Telnyx account still has 0 messaging profiles / 0 numbers (L2 verification +
  funding + A2P pending). `hostedSms` stays advisory — safe to launch without.

---

## C. Deploy sequence (once B1–B7 are set)

1. I merge branch `feat/sms-provider-abstraction` to `main` (public `openvpm`).
   Both `openvpm-app` (app.openvpm.com) and the demo project auto-deploy on push.
2. Before/at merge, ensure the production DB has this branch's migrations
   applied and RLS is enabled on the least-privilege `openpims_app` role:
   `pnpm db:migrate` then `pnpm db:rls` / `pnpm db:rls:test`.
   (New migration in this branch: `0025_practice_payment_accounts.sql` for the
   Connect payment-accounts table.)
3. After deploy, confirm `https://app.openvpm.com/api/health` → `ok: true`,
   `mode: hosted`, all non-advisory checks green.
4. Live smoke test (real card, refunded): register a clinic → $79 card-collected
   14-day trial ($0 due today) → verify email → confirm the subscription webhook
   flips the practice to trialing/active → cancel → confirm read-only lapse.
5. Connect smoke test (after B2): a clinic completes Connect Express onboarding,
   then takes a client invoice card payment; confirm the connect webhook marks
   the invoice paid.

## D. Marketing
- openvpm.com already shows $79 — consistent, no change needed.
- At paid go-live, confirm marketing CTAs point at app.openvpm.com/register
  (env `NEXT_PUBLIC_APP_URL` on the marketing project), not demo.

---

## Health-gate → env quick map (hosted, all HARD unless noted)

| Gate | Requires |
|------|----------|
| hostedCore | NEXTAUTH_URL, NEXT_PUBLIC_APP_URL, NEXTAUTH_SECRET, DATABASE_URL |
| hostedAppUrls | above two must be valid HTTPS |
| hostedBilling | STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (B3), STRIPE_CONNECT_WEBHOOK_SECRET (B3), STRIPE_SUBSCRIPTION_WEBHOOK_SECRET, STRIPE_PRICE_CLOUD_LOCATION → $79 live (B1) |
| hostedSubscriptionTax | STRIPE_TAX_ENABLED=true (B4) |
| hostedStorage | S3_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET/REGION (R2) |
| hostedEmail | RESEND_API_KEY, RESEND_WEBHOOK_SECRET (B5), EMAIL_SUPPORT_ADDRESS (B5), EMAIL_COMPANY_ADDRESS (B5) |
| hostedAi | ANTHROPIC_API_KEY or GOOGLE_API_KEY per AI_MODEL (B7) |
| hostedOps | CRON_SECRET + PLATFORM_ADMIN_EMAILS |
| hostedOpsAlerting | OPS_ALERT_WEBHOOK_URL (B6) |
| hostedCronHeartbeat | CRON_HEARTBEAT_URL (B6) |
| hostedSms (advisory) | Telnyx envs — deferrable (B8) |
