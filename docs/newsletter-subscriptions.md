# Confirmed newsletter subscriptions

The hosted newsletter uses a separate consent record on `growth_leads`.
Requesting updates never changes a demo disclosure, saved clinic preview, pause,
deletion, or platform email preference. Existing addresses captured only through
a notification are not subscribed automatically.

## Request and confirmation

The website posts to `/api/growth/newsletter` with an email, `consent: true`,
`disclosureVersion: "newsletter-confirmed-v1"`, an optional anonymous funnel UUID,
a coarse placement, and one interest: `general`, `offline`, `labs`, or `migration`.
The request promises three getting-started notes and occasional product updates.
Interest is self-reported context, not evidence that a clinic is ready to buy.

The endpoint validates allowed origins, body size, and per-IP/address limits.
New requests receive a signed 48-hour confirmation link. Retries within 15 minutes
reuse the token and provider idempotency key; a later request replaces the nonce.
Responses do not reveal whether an address exists, is paused, or is suppressed.

The link carries its token in a fragment. Opening the page does not confirm a
subscription. The reader must select **Confirm subscription**, which sends a POST.
The confirmation timestamp is immutable across retries. Confirmation links remain
usable when new signup requests are disabled. Expired or replaced links must be
requested again. The page does not need a staff session.

## Welcome sequence

`/api/cron/newsletter-followup` uses `CRON_SECRET`, the existing durable lead email
queue, stable provider idempotency keys, platform unsubscribe and suppression
checks, and cron heartbeats. It selects only valid confirmations after the
configured rollout timestamp. The three notes become eligible immediately,
after 48 hours, and after seven days, with at least 24 hours between actual
recorded sends. Unfinished introductions expire after 30 days. Delayed runs do
not send multiple steps at once.

A pause, deletion, or account created with the same address stops the introduction.
Suppressed introductions are retired from the queue without deleting subscription
history or re-enabling email. The sequence never restarts on a new signup request.
The interest-specific note describes current limitations; update that copy when
product availability changes. This cron sends only the three welcome notes;
ongoing product announcements require a separately reviewed campaign.

## Deployment and verification

Both switches default off. On self-hosted installations, the hosted billing guard
also disables these endpoints and sends.

1. Review and apply migration `0115_newsletter_subscription` through the normal
   migration workflow. Deploy the API, confirmation page, and cron.
2. Verify the configured email preference signing and identity keys against the
   existing registry, sender/reply address, provider, unsubscribe links, and cron
   heartbeat. Do not replace an identity key to make a health check pass.
3. With a dedicated test address, enable `NEWSLETTER_SIGNUP_ENABLED=true` and
   verify request, confirmation, retry, and unsubscribe. Test invalid and expired
   links. A GET must never confirm consent.
4. Deploy the website form with `NEXT_PUBLIC_NEWSLETTER_SIGNUP_ENABLED=true` only
   after the backend is ready. Keep the website and API disclosure versions equal.
   Retired `/api/subscribe` clients receive a refresh instruction, not a false
   subscription success.
5. Set a prospective UTC `NEWSLETTER_FOLLOWUP_ROLLOUT_AT`, then enable
   `NEWSLETTER_FOLLOWUP_ENABLED=true`. Verify controlled delivery before leaving
   the hourly schedule active. Monitor `newsletter-followup` heartbeats and queue
   outcomes. Disabling the follow-up switch stops future automated notes without
   altering consent or email preferences.

The optional local PostgreSQL integration tests run in randomly named disposable
databases, apply all migrations and RLS, and drop only those fixtures:

```sh
NEWSLETTER_DB_INTEGRATION=1 pnpm --filter @openpims/web exec vitest run \
  server/__tests__/newsletter.integration.test.ts \
  server/__tests__/newsletter-delivery.integration.test.ts
```

The delivery test substitutes the email transport; it proves queue, consent,
pacing, and suppression behavior without sending messages to real recipients.
