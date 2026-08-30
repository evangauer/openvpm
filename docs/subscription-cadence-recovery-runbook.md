# Subscription cadence recovery runbook

This runbook covers OpenVPM Cloud monthly-to-annual changes scheduled for the
subscription renewal boundary. It does not authorize production rollout. Keep
the feature behind the normal release, staging, and hosted-billing gates.

## Safety invariants

- Never update `subscription_cadence_operations` with ad hoc SQL. Database
  triggers enforce immutable request/provider evidence, exact revisions, and a
  narrow state graph.
- Never retry a Stripe mutation with a new idempotency key. The automatic
  billing-lifecycle worker reuses the operation's committed create/configure
  keys and performs provider calls outside database transactions.
- The monthly subscription must already use Stripe flexible billing mode.
  OpenVPM stops in `manual_review` for classic mode instead of performing the
  irreversible provider migration implicitly.
- The annual phase must preserve every explicitly allowlisted metered AI/SMS
  companion item. Missing, duplicated, or changed companion billing evidence
  is a provider mismatch; do not repair it by deleting the usage price.
- Never supersede `manual_review` until the exact Stripe subscription, attached
  schedule, and location quantity have all been independently reviewed.
- Superseding changes local workflow state only. It does not modify Stripe. If
  an unrecognized schedule remains attached, the next request will stop at
  provider inspection instead of replacing it.
- Do not paste raw Stripe payloads, payment details, secrets, or clinic records
  into tickets or chat. The operation id, revision, Stripe subscription id, and
  schedule id are sufficient for operator correlation.

## Normal automatic recovery

The authenticated `/api/cron/billing-lifecycle` job runs a bounded cadence
recovery batch before quantity reconciliation and lifecycle email work. It
selects only:

- unclaimed `reserved`, `authorized`, `schedule_created`, or `outcome_unknown`
  operations; and
- `inspecting`, `creating_schedule`, or `configuring_schedule` operations whose
  provider lease has expired.

At most ten operations are attempted per run. Stable provider idempotency keys,
short database claims, and compare-and-swap revisions make concurrent cron runs
safe. Heartbeat metrics report candidates, scheduled, outstanding
manual-review, deferred, and failed counts. Existing manual-review operations
remain visible on every run until an audited resolution clears them. Any
manual, deferred, or failed recovery degrades the heartbeat and requires
operator attention.

## Inspect a manual-review operation

Use a direct owner/recovery database credential. Do not use the ordinary app
role and do not put the credential in shell history.

```bash
OWNER_RECOVERY_DATABASE_URL='<direct owner URL>' \
  pnpm --filter @openpims/web billing:recover-cadence -- \
  inspect --operation-id '<operation UUID>'
```

Record the returned revision. In Stripe, verify all of the following against
the returned identifiers:

1. The subscription belongs to the expected OpenVPM practice/customer.
2. The attached schedule is either the operation-owned schedule or a known
   clinic/provider customization that must not be replaced.
3. The current and future location quantities match active OpenVPM locations.
4. The price/cadence and renewal boundary match the intended outcome.
5. No pending update, cancellation, pause, discount, transfer, threshold, or
   custom phase would be destroyed by later automation.

If evidence is unclear, stop. Leave the operation in `manual_review` and
escalate through the billing incident path. For `request_abandoned`, first
release or cancel the operation-owned provider schedule and verify that the
subscription remains on the intended monthly price with no pending update;
superseding only the local operation does not cancel anything in Stripe.

## Dry-run a local supersede

After correcting or deliberately abandoning the provider-side request, run a
dry-run with all three attestations:

```bash
OWNER_RECOVERY_DATABASE_URL='<direct owner URL>' \
  pnpm --filter @openpims/web billing:recover-cadence -- \
  supersede \
  --operation-id '<operation UUID>' \
  --expected-revision '<revision>' \
  --reason provider_corrected \
  --provider-schedule-reviewed \
  --subscription-reviewed \
  --quantity-reviewed
```

Allowed reasons are `provider_corrected`, `request_abandoned`, and
`subscription_replaced`.

## Execute the local supersede

Repeat the dry-run command with both flags below. The confirmation must include
the exact operation id and inspected revision:

```bash
  --execute \
  --confirmation 'SUPERSEDE:<operation UUID>:<revision>'
```

The execution locks the operation, rechecks `manual_review` and the exact
revision, advances it to immutable `superseded`, and writes an owner recovery
audit event. A revision mismatch fails and requires a fresh inspection.

## Post-recovery verification

1. Run `inspect` again and confirm `state: superseded` with the next revision.
2. Confirm the billing-lifecycle heartbeat is healthy on the next run.
3. Confirm Plan & Billing no longer shows a processing/manual-review request.
4. If the clinic remains monthly and wants annual billing, use the clinic admin
   confirmation flow. Provider inspection must pass from scratch.
5. Attach only bounded identifiers, state, revision, timestamps, reason, and
   heartbeat outcome to the incident record.
