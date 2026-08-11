# Security Overview

How OpenVPM protects practice and patient data. This is a factual summary of controls that exist in the codebase today. For the vulnerability reporting process, see [SECURITY.md](../SECURITY.md) at the repo root.

## Tenant isolation

Every tenant-scoped table carries a `practice_id` column, and the application layer filters every query by the signed-in user's practice. Isolation is covered by dedicated tests (`apps/web/server/__tests__/tenant-scoping.test.ts` and per-router scoping tests).

Behind the app-layer filters, Postgres Row-Level Security enforces the same boundary at the database:

- Policies live in `packages/db/rls/enable-rls.sql` and key off an `app.current_practice_id` setting the app sets per request inside a transaction (`apps/web/lib/tenant-db.ts`).
- Cross-tenant paths (platform admin, cron sweeps, pre-login flows) must opt in explicitly via a system context; there is no ambient bypass.
- CI runs a dedicated `rls` job (`.github/workflows/ci.yml`) that applies the policies to a real Postgres and runs live isolation tests (`packages/db/test-rls.ts`) connected as the application role, proving one tenant cannot read another's rows.

## Least-privilege database role

The hosted application connects as `openpims_app`, a role with only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` grants. It does not own tables, so it cannot alter schema and cannot bypass RLS. Migrations run separately on the owner connection.

## Backups and restore validation

A scheduled job (`apps/web/app/api/cron/backup`, daily at 03:00 UTC) exports each practice's full data set to a private S3-compatible object storage bucket, one restorable snapshot per practice per day. The export includes the complete medical record: persisted SOAP drafts, immutable finalized SOAP attribution, correction and addendum evidence, clinical notes, problem lists, lab results, prescriptions, vaccination records, vital signs, and the controlled substance log, alongside scheduling, client, inventory, and billing data (`apps/web/lib/backup/export.ts`). When the separately gated replica target is configured, the job also writes and read-back verifies each JSON snapshot in an independent failure domain.

Restores are validated before anything is written: the backup file is checked against the expected sections and row shapes, and invalid or oversized files (over 50 MB) are rejected (`validatePracticeExportRestore`, `apps/web/lib/backup/policy.ts`). Backup failures page the operators through the ops alert webhook, and a dead-man heartbeat monitors that the job actually ran.

Attachment objects carry SHA-256/size manifests. A leased background worker copies them asynchronously to content-addressed keys in independent object storage, reads every copy back before marking it available, records append-only transition evidence, and periodically re-verifies coverage. The application may fall back only to a checksum-verified replica; missing, corrupt, and provider-failure states remain distinct. Operational activation additionally requires separate-account IAM without runtime delete authority, versioning/immutable retention, full backfill, and a destructive recovery drill as documented in `docs/file-object-recovery-runbook.md`.

## Rate limiting

Rate limiting is durable, not in-memory. A fixed-window limiter stores counters in Postgres (`apps/web/lib/rate-limit.ts`), so limits hold across serverless instances and process restarts. Overlong keys are hashed, responses carry standard `Retry-After` and `X-RateLimit-*` headers, and a daily cron prunes expired buckets. Sensitive public surfaces such as the client portal use it on their read paths.

## Security headers

Every response gets a strict header set (`apps/web/lib/security-headers.js`, applied through `next.config.js` and the middleware):

- `Content-Security-Policy` with `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, and `upgrade-insecure-requests` in production
- `Strict-Transport-Security` for two years with `includeSubDomains` and `preload`
- `Permissions-Policy` denying camera, microphone, geolocation, payment, and USB
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`

## Audit log

Mutations are recorded to an `audit_log` table with the practice, user, IP address, action, entity, and a redacted copy of the change (`apps/web/lib/audit.ts`). Secret-like fields (passwords, tokens, keys) are stripped before storage. Audit writes are best-effort and never block or fail the underlying request.

## Capability URLs

Public links are capability URLs: possession of the unguessable token is the credential, and the token grants only one narrow capability.

- Client portal links (`/portal/<token>`) use a unique per-client access token and expose only that client's own data.
- The practice calendar feed (`/api/calendar/<token>`) uses a unique practice-level token that can be rotated, which invalidates every previously shared URL.

## Authentication

Passwords are hashed with bcrypt. All dashboard routes require an authenticated session, enforced in middleware. API keys are stored as bcrypt hashes with an indexed lookup prefix; the raw key is shown once and never persisted.

## Responsible disclosure

Please do not report security issues through public GitHub issues. Email **security@openvpm.com** with `[SECURITY]` in the subject line. We acknowledge reports within 48 hours and follow the 90-day coordinated disclosure process described in [SECURITY.md](../SECURITY.md).
