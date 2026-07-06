# Row-Level Security (RLS)

OpenVPM enforces multi-tenant isolation in two layers:

1. **Application layer** — every query is scoped by `ctx.practiceId` (tRPC) or
   the API key's practice. This is the primary guard and works on any database.
2. **Database layer (RLS)** — Postgres policies that independently reject any row
   whose `practice_id` doesn't match the active tenant context. Defense in depth:
   even a query that forgets its `practiceId` filter returns nothing.

## How it works

Policies key off a per-transaction GUC, `app.current_practice_id`, set by the
app (`apps/web/lib/tenant-db.ts`):

- `withTenant(db, practiceId, fn)` — opens a transaction, sets the tenant GUC,
  runs `fn` on that transaction. Used by `protectedProcedure` so the whole
  authenticated request is tenant-scoped.
- `withSystem(db, fn)` — sets `app.rls_bypass = on` for legitimately
  cross-tenant or pre-tenant work (login, registration, the client portal,
  platform admin, the API-key lookup).

The policy on every tenant table is:

```sql
USING      (app_rls_bypass() OR practice_id = app_current_practice_id())
WITH CHECK (app_rls_bypass() OR practice_id = app_current_practice_id())
```

With no context set, the GUC is NULL → the policy denies by default.

## The owner-bypass model (why dev/self-host is unaffected)

We deliberately do **not** use `FORCE ROW LEVEL SECURITY`. The table **owner**
bypasses RLS, so:

- Migrations, `pnpm db:push`, `pnpm db:seed`, and **dev / self-host** (which
  connect as the owner `openpims`) are completely unaffected — RLS is a no-op.
- Enforcement turns on only when the app connects as the **least-privilege role**
  `openpims_app` (created by the migration), which is subject to RLS.

This means RLS is safe to ship: it adds protection for the restricted role
without any risk to the default configuration.

## Applying it

```bash
# Set a strong password for the app role; the script creates the role if missing
# (no credential is stored in the repo) and applies the policies + grants.
OPENPIMS_APP_DB_PASSWORD='<strong-password>' pnpm db:rls   # run as the DB owner
OPENPIMS_APP_DB_PASSWORD='<same-password>' pnpm db:rls:test   # live verification
```

`db:rls:test` checks, against a real database as `openpims_app`: a tenant sees
only its own rows, cross-tenant INSERT is rejected, no-context queries return
nothing, and the system bypass sees everything.
Both scripts trim `OPENPIMS_APP_DB_PASSWORD`; whitespace-only values are treated
as missing, and `db:rls:test` uses the same password that was used to create or
rotate the app role.

## Activating enforcement in production

1. `OPENPIMS_APP_DB_PASSWORD='<strong>' pnpm db:rls` against the production database
   (creates the `openpims_app` role with that password — or rotates it if it
   already exists — then applies policies + grants).
2. Run `OPENPIMS_APP_DB_PASSWORD='<same-password>' pnpm db:rls:test` against the
   same database to prove isolation with that credential.
3. Point the hosted `DATABASE_URL` at the `openpims_app` role.

### Entrypoint coverage (all wired)

Every DB access path now sets a tenant or system context, so the app runs
correctly under the enforcing `openpims_app` role:

- tRPC `protectedProcedure` → `withTenant`; `publicProcedure` + login → `withSystem`;
  platform admin → `withSystem`; API-key auth lookup → `withSystem`.
- `app/api/v1/*` data queries → `withTenant(auth.ctx.practiceId, ...)`.
- `app/api/cron/*` (reminders, backup) → broad reads in `withSystem`, per-practice
  writes/exports in `withTenant`.
- `app/api/webhooks/*` (client + subscription) and `lib/webhook-dispatcher.ts` →
  `withSystem` / `withTenant(practiceId)`.
- `app/api/upload` → `withTenant(session.practiceId, ...)`;
  `app/api/portal/checkout` → `withSystem`.

These are no-ops on the owner connection (dev/self-host). To activate enforcement
in production: run `OPENPIMS_APP_DB_PASSWORD='<strong>' pnpm db:rls`, verify with
`OPENPIMS_APP_DB_PASSWORD='<same>' pnpm db:rls:test`, and point `DATABASE_URL` at
the `openpims_app` role (Phase 5 infra). Re-run the same verification against
staging to confirm isolation under the restricted role.
