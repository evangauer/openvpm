# OpenVPM Cloud Production Runbook

Clinic onboarding and graduation are governed by the
[controlled clinic pilot operations runbook](clinic-pilot-operations.md) and
the [clinic readiness boundary](clinic-pilot-readiness.md).

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

For a direct customer handoff, use
`https://app.openvpm.com/register?next=%2Fsettings%3Ftab%3Dbilling`. After
registration and automatic sign-in, the admin lands in **Settings → Plan &
Billing**, chooses monthly or annual billing, and continues to Stripe. The top
trial badge and dashboard activation checklist route to this same billing
surface.

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
# Default-off. Set both only after reviewing the verified-admin recipient
# cohort; the timestamp is the prospective closeout eligibility boundary.
FIRST_CLINIC_WIN_ENABLED=false
FIRST_CLINIC_WIN_ROLLOUT_AT=
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
STRIPE_PRICE_CLOUD_LOCATION_ANNUAL=...
STRIPE_TAX_ENABLED=true

S3_ENDPOINT=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_REGION=...

# Independent recovery storage. Stage a complete group with execution disabled,
# then enable only an exact design-partner cohort after bucket controls pass.
FILE_REPLICA_REQUIRED=false
FILE_REPLICA_ENABLED=false
FILE_REPLICA_ALL_PRACTICES=false
FILE_REPLICA_PRACTICE_IDS=
FILE_REPLICA_S3_ENDPOINT=
FILE_REPLICA_S3_ACCESS_KEY=
FILE_REPLICA_S3_SECRET_KEY=
FILE_REPLICA_S3_BUCKET=
FILE_REPLICA_S3_REGION=

RESEND_API_KEY=...
RESEND_WEBHOOK_SECRET=...
EMAIL_PREFERENCE_IDENTITY_SECRET=... # stable `openssl rand -base64 32`; never rotate without migrating preference data
EMAIL_PREFERENCE_SIGNING_SECRET=... # rotatable `openssl rand -base64 32`; do not reuse another secret
EMAIL_PREFERENCE_SIGNING_SECRET_PREVIOUS= # comma-separated former signing keys retained for delivered links
EMAIL_PREFERENCE_BASE_URL=https://app.openvpm.com
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
CRON_HEARTBEAT_FILE_REPLICAS_URL=...
PLATFORM_ADMIN_EMAILS=...
```

`STRIPE_PRICE_CLOUD_USER` and `STRIPE_PRICE_CLOUD` are legacy-only. They must not be used for new checkout or required hosted readiness.

Any nonblank `FILE_REPLICA_*` value starts the replica readiness gate. Partial
storage configuration makes `/api/health` fail, and a complete configuration
must point to a different endpoint/bucket identity from primary storage.
Credentials alone do not copy data. `FILE_REPLICA_ENABLED=true` additionally
requires either an exact comma-separated UUID cohort in
`FILE_REPLICA_PRACTICE_IDS` or `FILE_REPLICA_ALL_PRACTICES=true`, never both.
Begin with the design-partner cohort and expand only after its recovery drill.
Follow
[`file-object-recovery-runbook.md`](file-object-recovery-runbook.md) for bucket
controls, backfill, alert thresholds, and the required destructive drill before
setting `FILE_REPLICA_REQUIRED=true`.

Telnyx is the hosted SMS default. `TELNYX_PUBLIC_KEY` is required for the
public webhook to verify inbound SMS and delivery-status callbacks. For a
hosted Telnyx deployment, set a dedicated 32-byte
`MESSAGING_REGISTRATION_ENCRYPTION_KEY` before collecting clinic A2P details.
Normal clinic sends use the per-location profile and number stored after the
location completes texting setup. `TELNYX_MESSAGING_PROFILE_ID` and
`TELNYX_FROM_NUMBER` are optional platform fallback sender values for legacy or
development calls that do not specify a location; do not point them at an
individual clinic merely to satisfy readiness checks.
For production CLI work, run from the repository root and explicitly target
the `openvpm-app` Vercel project. Do not rely on a nested or cached `.vercel`
link when reading or changing SMS variables. The protected platform-admin SMS
configuration card identifies which credential shape is invalid without
returning any secret value.
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
Telnyx location has carrier-active registration, an explicitly activated and
read-back provider profile, and the clinic has passed pilot review. A hosted
send requires the practice UUID in `MESSAGING_SENDING_PRACTICE_IDS` and the
exact location UUID in `MESSAGING_SENDING_LOCATION_IDS`; the hosted pilot
permits only one enabled location per practice. Missing, ambiguous, Twilio,
inactive, or partially configured state makes no provider call. These
three variables are hosted-only and do not gate intentional self-host messaging
configuration. Arbitrary hosted test destinations remain disabled; validate
through a current, consented client workflow after approval.

While provisioning, sending, and all SMS allowlists remain off/empty, the
hosted SMS entry in `/api/health` is advisory. The first rollout signal —
enabling provisioning or sending, or staging any pilot allowlist — makes the
Telnyx provider selection, API key, webhook verification key, registration
encryption key, and exact single-clinic pilot scope release-blocking. A partial,
malformed, or multi-clinic pilot scope therefore returns `503` before a deploy
can appear healthy. Provisioning and sending scopes must name the same active
clinic. A sending location must belong to that clinic and have an active Telnyx
registration, sender identity, campaign assignment, and verified provider
profile in the production database. This health check complements the runtime
send gates; it does not enable provisioning or sending. Rollout health also rejects placeholder
credentials: the Telnyx v2 API key must use the provider's `KEY_` format, and
both the Ed25519 webhook public key and registration encryption key must decode
to 32 bytes. The same structural check remains visible as advisory health while
the rollout is deferred. A healthy shape is still not proof of account access;
verify the key with a read-only provider request and complete the live drill
below.

### Controlled texting pilot activation

Provider profiles are created disabled. Never enable one during number
purchase or carrier submission. Use the platform admin queue in this order:

> **Current release gate:** keep `MESSAGING_INBOUND_ENABLED=false`. Signed
> hosted callbacks are acknowledged without tenant projection, and provider
> profile activation is blocked, until the durable recovery-aware inbound event
> inbox is deployed. Provisioning and carrier review may be prepared, but do
> not proceed to provider activation or live SMS in this release.

1. Reconcile the brand as `VERIFIED` or `VETTED_VERIFIED`, the campaign as
   `ACTIVE` or `MNO_PROVISIONED`, and the exact number assignment as `ASSIGNED`.
2. Select **Inspect profile**. OpenVPM reads the exact profile, owned number,
   brand, campaign, and assignment. The profile must have the canonical v2
   webhook, a US-only destination allowlist, smart encoding, and the enforced
   `$10.00` daily cap. A new profile may still report its clinic-specific
   auto-response rules as missing at this read-only step.
3. After the durable inbound-event release is deployed and its recovery drill
   passes, confirm the every-five-minute `sms-provider-events` writer heartbeat,
   an empty redacted provider-event queue, and a healthy read-only
   `sms-operations` heartbeat. Then set `MESSAGING_INBOUND_ENABLED=true`, select
   **Enable provider profile**, and confirm the provider mutation. OpenVPM
   first installs and reads back the exact clinic-branded US START, STOP, and
   HELP rules using the registered clinic name and support phone. Missing,
   duplicate, wildcard, paginated, or changed rules block activation. OpenVPM
   then reads every provider prerequisite back after the update and deliberately
   leaves the clinic database sender off. Provider activation remains blocked
   if exact or identity-matched pending, retry, recovery-blocked, quarantined,
   or unreviewed identity-conflict evidence exists.
4. Add exactly one practice and location to the sending allowlists and set
   `MESSAGING_SENDING_ENABLED=true`.
5. Within 15 minutes of the provider readback, have the clinic admin enable the
   location sender. This transaction takes the practice row before reading the
   event queue and refuses to enable while relevant evidence remains. An expired
   or failed attestation blocks the database switch; inspect the profile again
   instead of bypassing the gate.
6. Validate only with a current, consented client workflow. Confirm outbound
   accepted-to-delivered evidence, an ordinary inbound reply, HELP, STOP plus a
   blocked resend, START plus restored consent, one reminder, usage metering,
   and empty reconciliation queues.

The kill sequence is global sending off first, then clear both sending
allowlists, disable the clinic database sender, and finally select **Disable
provider profile**. Provider deactivation always closes the database gate before
contacting Telnyx, so an uncertain carrier response cannot leave OpenVPM sending.

### Texting operations response

The every-five-minute `/api/cron/sms-provider-events` job is the only scheduled
provider-event projection writer. It claims a bounded batch, uses transactional
row locking and idempotent terminal states, retries failures, never sends an SMS
or mutates a provider profile, and reports a
dedicated `sms-provider-events` heartbeat. A crash leaves the durable event
queued. Keep this writer separate from the monitor below.

The every-15-minute `/api/cron/sms-operations` check is read-only. Its cadence
matches the shortest unresolved-send threshold. It does not enable a provider
profile, change a launch flag or allowlist, send or retry a message, or reconcile
evidence. It sends one bounded, PHI-free operations alert only when
the health computation finds an exception; a healthy run emits only its cron
heartbeat.

Use these fixed thresholds and responses:

- **P0 — enabled but unsafe:** an enabled location has missing or inactive
  registration/provider state, missing sender/profile identity, a failed-closed
  profile-readiness gate, registration/profile identity drift, more than one
  enabled hosted location for a practice, or read-only provider inspection finds
  unsafe profile, number, campaign, or assignment state. Turn global sending off,
  clear both sending allowlists, disable the clinic sender, and investigate the
  exact provider state before reactivation. Do not work around a failed gate.
- **P1 — carrier action:** registration or sender state is failed, suspended, or
  action-required; a submission lock is older than 15 minutes; or pending/not
  started carrier work has had no provider sync or activity for 24 hours. Review
  the carrier portal and immutable registration history before taking a bounded,
  explicit operator action.
- **P1 — profile attention:** a disabled clinic's provider-readiness attestation
  has passed its 15-minute activation window, current provider state has drifted,
  or a read-only provider inspection could not complete. Reinspect; do not infer
  readiness or automatically mutate the provider. An enabled sender is not
  classified as unsafe solely because its original activation attestation is
  older than 15 minutes; current provider inspection controls that decision.
- **P1 — send/delivery operations:** review send-attempt exceptions after 15
  minutes and delivery-event exceptions or accepted sends without final provider
  evidence after 60 minutes. Use the exact admin queues and their constrained
  review actions; never attach ambiguous evidence to an arbitrary clinic or
  retry an SMS from the monitoring job.
- **Provider-event projection:** pending/retry work older than 15 minutes and
  recovery-blocked work are P1. A quarantined event or unreviewed provider-event
  identity conflict is P0 and keeps activation closed. A conflict review clears
  only the identity-conflict alert; it never clears the incident by itself. Use
  the platform-admin **SMS evidence recovery** console to select the exact event
  and, when present, the exact conflict. The console offers only the resolution
  supported by durable evidence:

  - inbound projection repair must produce the exact communication and any
    required START/STOP consent event;
  - conflicting inbound evidence is resolved conservatively as a system-actor
    opt-out with an active suppression;
  - A2P evidence requires a current read-only carrier reconciliation and leaves
    every sender disabled and unready; and
  - delivery-only closure requires an explicit provider-support finding and a
    bounded reference containing no phone number, message, client name, or PHI.

  Each action uses a fresh operation UUID and appends an immutable resolution
  row; it never changes or deletes the terminal provider event. A later conflict
  reopens the gate until that new conflict has both review and resolution
  evidence. During practice recovery, audited remediation is serialized under
  the practice row lock and may append proof while the hold remains set. Recovery
  release, provider-profile activation, clinic sender enablement, and final SMS
  dispatch all remain blocked until the base incident and every conflict have
  their required evidence.

Alerts contain only bounded counts and reason codes. They must not contain phone
numbers, recipients, message bodies, clinic/patient/client names, raw provider
payloads, or full provider identifiers. Resolve every P0 before any pilot sends;
record and clear P1 items through the existing operator evidence workflow.

For a Twilio fallback deployment, set `MESSAGING_PROVIDER=twilio` and provide
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` instead of
the Telnyx send envs. Every Twilio send configures the canonical
`/api/webhooks/twilio` status callback with bounded connection-override retries;
do not replace it with a clinic-specific callback.

Authenticated Telnyx and Twilio delivery callbacks are inserted into the
append-only `sms_delivery_events` ledger before attribution. Only normalized
provider lifecycle fields are stored: provider/event/message ids, event type,
bounded status/error tokens, timestamps, classification, and a deterministic
redacted fingerprint. Raw callback payloads, sender/recipient phone numbers,
and message bodies are never stored in this delivery ledger. Attribution uses
only the exact provider plus provider message id from immutable accepted-send
evidence; sender number and messaging-profile hints are never authority. The
communication projection is monotone (`unknown < sent < failed < delivered`),
so late or duplicate callbacks cannot downgrade a delivered message and a
delivered callback can correct an earlier failure.

Platform operators review `admin.smsDeliveryEventQueue`. Its actionable event
items (unmatched, ambiguous identity, unknown status, projection miss) are
separate from monitor-only accepted sends that remain without a provider-final
state after the configured age threshold. An operator may retry exact
attribution, repair a projection, or record a provider-portal classification
only after one exact attempt exists. Truly unmatched/ambiguous evidence can
only receive an append-only quarantine review; it cannot be manually linked to
an arbitrary clinic or attempt. Provider evidence and every operator review
are immutable unless the database owner explicitly enables the maintenance
GUC. While an account is active there is no automated pruning job: append-only
provider evidence must remain complete for clinic audit and incident recovery.
Indefinite retention after account closure is not authorized. After the
promised 60-day export period, the account-closure owner-maintenance procedure
must purge the practice's SMS attempt/history rows and then any global delivery
events that have no remaining exact accepted-send match and no unresolved
identity incident. Missing attribution alone is not safe deletion authority;
another practice may share the provider/message identity under investigation.
Backups age out under the same closure policy. Provider identifiers and
platform-operator identities in these ledgers are part of that purge scope.

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
`EMAIL_PREFERENCE_IDENTITY_SECRET` is the stable HMAC identity key for PII-free
recipient hashes. Never rotate it without a coordinated migration of persisted
preference identities. `EMAIL_PREFERENCE_SIGNING_SECRET` signs new durable
unsubscribe links. To rotate it safely, move the former current key into the
comma-separated `EMAIL_PREFERENCE_SIGNING_SECRET_PREVIOUS` key ring before
installing the new key; retain former keys for as long as delivered links must
continue working. Keep both kinds of key separate from each other and from
`NEXTAUTH_SECRET`.

`EMAIL_PREFERENCE_BASE_URL` must be the canonical HTTPS origin
`https://app.openvpm.com` in every hosted deployment. This ensures demo and
campaign email writes recipient choices to the canonical hosted database rather
than a deployment-local database. Optional platform email fails closed when the
required preference configuration is missing or invalid; security, receipt,
and service email is unaffected.

The daily `/api/cron/setup-recovery` sweep sends at most two optional setup
emails to the clinic's earliest verified admin. The first is eligible only after
24 hours without setup progress; the second requires at least 72 hours of both
continued inactivity and email cooldown. Completed or activated clinics,
self-host paths, clinics that requested human help, analytics-excluded rows,
recovery-held practices, expired trials, and trials with less than 48 hours
remaining are excluded. Every send uses the shared preference/suppression gate,
a campaign-versioned idempotency key, and the saved setup step. It never includes
patient data and never asks a clinic to email an export or make it public.

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

The server pins Stripe API version `2026-07-29.dahlia`. Configure all three
Dashboard webhook endpoints below to that same version before deploying an SDK
upgrade, then replay a signed test event for every subscribed event type.
Checkout uses Stripe's dynamic eligible payment methods; do not force a
card-only method list in Dashboard rules. Invoice Checkout still uses manual
capture, so Stripe automatically filters out methods that cannot support the
authorization-and-capture flow.

Create one Stripe product for OpenVPM Cloud with these recurring prices:

- Cloud location: `$79/month`, env `STRIPE_PRICE_CLOUD_LOCATION` (flat per active location, unlimited staff).
- Cloud location annual: `$790/year`, env `STRIPE_PRICE_CLOUD_LOCATION_ANNUAL` (two months free, flat per active location, unlimited staff).
- Legacy `$0/month` seat price, env `STRIPE_PRICE_CLOUD_USER` — kept only so existing split-price subscriptions can still map to Cloud during webhook and quantity-sync processing. It is not added to new checkout and is not required by `/api/health`.
- AI overage metered price, env `STRIPE_PRICE_AI_OVERAGE`.
- SMS overage metered price, env `STRIPE_PRICE_SMS_OVERAGE`.

`STRIPE_PRICE_CLOUD` (legacy single price) is only kept for mapping existing subscriptions; new checkout never uses it. Set `STRIPE_PRICE_AI_OVERAGE` and `STRIPE_PRICE_SMS_OVERAGE` when overage billing should be active; if either is omitted, usage is still recorded locally and reconciliation can report it, but Stripe will not bill that overage line.

### Included allowance + metered overage (Stripe Billing Meters)

The Cloud plan includes **1,000 AI actions + 1,000 SMS per month**, then bills **$0.05/AI action** and **$0.03/SMS**. This is modeled with Stripe Billing Meters (the legacy usage-records API is gone as of API version 2025-03-31.basil):

1. Create two meters — `openvpm_ai_run` and `openvpm_sms` — with sum aggregation, value payload key `value`, and customer mapping by `stripe_customer_id`. The event names must match `lib/billing/stripe-meters.ts`.
2. Create a graduated metered price per meter with the included allowance as the $0 first tier: tiers `[{ up_to: 1000, unit_amount: 0 }, { up_to: inf, unit_amount: 5 }]` for AI (cents) and `… unit_amount: 3` for SMS, each with `recurring.usage_type=metered` and `recurring.meter=<meter id>`. Wire to `STRIPE_PRICE_AI_OVERAGE` / `STRIPE_PRICE_SMS_OVERAGE`.

Monthly and annual Checkout each show one customer-facing OpenVPM Cloud item (quantity = active non-deleted locations, kept current by quantity sync). Monthly subscription sync can attach configured quantity-less metered items after Checkout; annual founding subscriptions remain flat-rate so the first purchase and invoice stay simple. `recordUsage()` writes the local `usage_records` row (display/reconcile source of truth) and, once the practice has a Stripe customer, reports a meter event where metered billing is active. Before the conversion Stripe checkout completes, there is no customer to meter against, so any pre-checkout usage stays local. Leaving the overage price envs unset keeps usage recorded but unbilled.

Stripe Tax gates hosted readiness. Complete Stripe Tax registrations and origin-address setup in Stripe, then set `STRIPE_TAX_ENABLED=true` so subscription checkout collects billing address/tax IDs and lets Stripe calculate tax on the Cloud subscription. Client invoice payments stay on OpenVPM's already-totaled invoice amounts and do not add Stripe Tax again.

Client invoice payment webhook endpoint:

```text
https://app.openvpm.com/api/webhooks/stripe
```

Subscribe to:

- `checkout.session.completed`

Store this endpoint secret as `STRIPE_WEBHOOK_SECRET`.

### Stripe Connect for clinic-owned client payments

OpenVPM Cloud uses controller-configured connected accounts with a full Stripe
Dashboard for clinics that want to bill pet owners by card. Stripe owns ongoing
requirements collection and negative-balance liability, while each clinic pays
its processing fees. This is separate from the OpenVPM Cloud subscription
above: Cloud subscription charges settle to OpenVPM, while client invoice
payments are created on the clinic's connected account after onboarding is
complete.

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
`CRON_HEARTBEAT_FIRST_CLINIC_WIN_URL`,
`CRON_HEARTBEAT_SETUP_RECOVERY_URL`,
`CRON_HEARTBEAT_WELLNESS_BILLING_URL`,
`CRON_HEARTBEAT_RATE_LIMIT_CLEANUP_URL`,
`CRON_HEARTBEAT_AUTH_CLEANUP_URL`,
`CRON_HEARTBEAT_ACTIVATION_DIGEST_URL`,
`CRON_HEARTBEAT_SMS_OPERATIONS_URL`,
`CRON_HEARTBEAT_SMS_PROVIDER_EVENTS_URL`,
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
