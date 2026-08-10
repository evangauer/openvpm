# Conversion evidence and reconciliation

OpenVPM’s clinic conversion funnel uses exact, locally auditable evidence. The
canonical repairable projection is `practice_conversion_milestones`; browser
journey telemetry remains in `funnel_events` and is not a business-stage source
of truth.

The [controlled clinic pilot operations runbook](clinic-pilot-operations.md)
adds a separate, audited operating layer for qualified clinics. Pilot stages
and decisions never replace the canonical conversion evidence below.

## Canonical definitions

| Milestone                | Exact source                                                                                                                         | Occurrence time                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Registered               | committed `practices` row                                                                                                            | `practices.created_at`                              |
| Activated                | earliest non-demo client plus earliest non-demo appointment                                                                          | later of practice, client, and appointment creation |
| Payment method collected | signed subscription `checkout.session.completed` with `mode=subscription`, `payment_method_collection=always`, and a subscription id | signed Stripe `event.created`                       |
| First positive payment   | signed subscription `invoice.payment_succeeded` with `amount_paid > 0`, valid currency, and a subscription id                        | signed Stripe `event.created`                       |

`observed_at` is when the projection first saw evidence. It is never used as a
conversion timestamp. Reconciliation may repair `occurred_at` to an earlier
exact source event but never moves it later.

Current `billing_status=active` is reported separately as current state. It does
not prove when a payment happened. A subscription id does not prove that a card
was collected. Zero-dollar trial invoices do not prove a positive payment.

## Legacy quarantine

Historical `funnel_events` named `registration`, `activation`, `card_added`, or
`paid` are retained for audit compatibility but excluded from canonical reports.
Some legacy payment-stage rows were derived from status or update timestamps, so
they cannot be assigned a trustworthy occurrence time. They are surfaced only
as data-quality counts. Unknown is not treated as zero and receives no synthetic
date.

The migration backfills registration and activation only, because those stages
have exact local source timestamps. Stripe evidence is captured prospectively in
the system-only `stripe_events` claim ledger. It stores an allowlisted event id,
object id, event time, evidence kind, practice mapping, and positive amount and
currency where relevant—never a raw Stripe payload or customer contact data.

## Repair and monitoring

`GET /api/cron/conversion-reconcile` runs hourly through `apps/web/vercel.json`.
It is protected by the normal cron secret and reads only local Postgres evidence;
it never calls Stripe. Configure either the global `CRON_HEARTBEAT_URL` or the
job-specific `CRON_HEARTBEAT_CONVERSION_RECONCILE_URL` and alert when the job is
missing or failed.

The platform admin funnel and weekly activation digest expose:

- legacy business-stage rows excluded;
- clinics with unknown payment-method or positive-payment evidence;
- missing registration or activation projections;
- mapped Stripe evidence not yet projected; and
- signed Stripe evidence that could not be mapped to an active practice.

Journey cohorts are anchored to each anonymous visitor's all-time first-party
touch, then filtered to the reporting window. Returning visitors are not
re-cohorted. Abandonment ages from the exact stage event: first touch before a
demo, demo submission before registration, and each canonical milestone after
registration.

Clinic setup reporting is similarly durable. Setup starts at the first saved
`onboardingIntentSelectedAt` (with the legacy step cursor or completion marker
as fallbacks), and that first timestamp never changes when a clinic revisits its
path. `journeyLastProgressAt` advances only after a setup action is persisted
successfully and is used to age stalled setup in the recovery queue. Completion
is also first-write-wins, so reopening or replaying the finish action cannot
move a clinic into a newer cohort.

Sample clinic IDs are cumulative provenance. Clearing sample data soft-deletes
the rows but retains every ID with a `clearedAt` marker; reseeding merges new IDs
into that history and clears the marker. This prevents old sample rows from
becoming apparent real activation evidence. Account creation, starter catalog
seeding, sample seeding, and initial provenance commit together, while clear and
reseed operations are serialized per practice.

Investigate non-zero projection drift if it persists beyond one hourly run.
Unmapped Stripe evidence needs an operator to correct the authoritative Stripe
customer/subscription-to-practice mapping; do not edit evidence timestamps or
copy a milestone between practices.

## Deployment checklist

1. Apply Drizzle migrations before deploying web code.
2. Re-apply `packages/db/rls/enable-rls.sql` in hosted environments and verify
   the `openpims_app` role can use system bypass while tenant sessions see no
   conversion or Stripe evidence rows.
3. Confirm Stripe sends `checkout.session.completed` and
   `invoice.payment_succeeded` to the subscription webhook with the subscription
   signing secret.
4. Confirm `CRON_SECRET`, the hourly reconciliation schedule, and heartbeat
   monitoring are active.
5. Inspect the admin evidence-quality panel after the first reconciliation run.
