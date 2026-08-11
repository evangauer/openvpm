# Provider-free SMS concurrency drill

This drill proves the clinic-safe SMS lock and recovery invariants against real
PostgreSQL. It uses only synthetic UUIDs, phone numbers, provider identifiers,
and message text. It never loads a Telnyx or Twilio adapter, calls a provider,
or requires provider credentials.

The drill is intentionally restricted to a PostgreSQL URL whose host is
`localhost`, `127.0.0.1`, or `::1`. Do not point it at production, demo,
staging, a Supabase pooler, or any shared database. Each scenario cleans up its
synthetic rows with the schema's owner-only `app.ledger_maintenance` bypass,
which is available only because the disposable test connection owns the tables.
Cleanup fails closed before enabling that bypass if a scenario unexpectedly
creates an immutable `sms_provider_event_resolutions` row.

## What it proves

1. **STOP versus outbound send.** Intake holds the practice row and exact
   recipient advisory lock, commits a durable STOP, and only then allows the
   outbound final barrier to continue. The barrier observes the STOP and the
   synthetic provider-call counter stays zero.
2. **Conflict replay versus projection.** A replay and the projector both use
   `practice -> exact sender -> recipient -> provider event`. PostgreSQL lock
   waiters are observed directly before release. Both transactions finish
   without a deadlock, the conflicting body is recorded, and the original
   event remains quarantined.
3. **Callback-first DLR convergence.** A delivery callback arrives before its
   accepted send, remains durable as retryable evidence, and later converges to
   one attributed, projected delivery after the exact accepted-send identity is
   inserted. The linked communication becomes delivered.
4. **Recovery drain, savepoint, and release.** One event projects successfully;
   a deliberate PostgreSQL error aborts only the next event savepoint. The
   outer recovery transaction commits the first projection and a blocked-release
   audit while keeping the hold true. A later locked drain reaches zero backlog
   before the synthetic hold is released.

## Run locally

Start a disposable PostgreSQL 16 database, apply every committed migration,
then run the dedicated command from the repository root:

```sh
export DATABASE_URL=postgresql://openpims:openpims@localhost:5432/openpims
pnpm --filter @openpims/db db:migrate
pnpm --filter @openpims/web test:sms-concurrency
```

The command forces these flags off regardless of the surrounding shell:

```text
MESSAGING_PROVISIONING_ENABLED=false
MESSAGING_INBOUND_ENABLED=false
MESSAGING_SENDING_ENABLED=false
```

Expected result: one test file and four tests pass. A skip means the dedicated
command was not used. A timeout, PostgreSQL deadlock, residual backlog, provider
call, or cleanup failure is a release blocker; do not “fix” the drill by
increasing timeouts or enabling an SMS capability.

## CI

The `RLS tenant isolation` job applies all migrations and RLS to its disposable
PostgreSQL 16 service, first executes the live provider-resolution trigger and
evidence contract, then runs this drill with
`SMS_CONCURRENCY_DB_INTEGRATION=1` and all three SMS flags explicitly false.
The ordinary unit-test job leaves the file skipped because it has no database
service.

When changing intake, projection, suppression, DLR attribution, recovery drain,
or provider-event remediation, keep this drill green and preserve the canonical
lock order. If a new immutable evidence table references synthetic event rows,
the drill must assert it created no such evidence before entering local
maintenance cleanup. The bypass must never be added to production recovery or
remediation flows.
