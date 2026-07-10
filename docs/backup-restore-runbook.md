# Backup and Restore Runbook

OpenVPM Cloud takes a full backup of every practice every day. This runbook
covers what is in those backups, how to restore one, and the drill log that
proves the whole path works.

## What gets backed up

- **When:** daily at 3:00 AM UTC (`/api/cron/backup`, see `apps/web/vercel.json`).
- **Where:** object storage, one file per practice per day:
  `backups/{practiceId}/{YYYY-MM-DD}.json` (date in the practice's timezone).
- **What:** every practice-owned table, active rows only. That includes the
  full clinical record (SOAP notes, clinical notes, vitals, vaccinations,
  labs, procedures, prescriptions, problem lists, cases, treatment plans,
  controlled-substance log), clients and patients, scheduling, billing
  (invoices, items, payments, adjustments, claims), inventory, staff, and the
  audit log. The canonical section list is `PRACTICE_EXPORT_SECTIONS` in
  `apps/web/lib/backup/export.ts`.
- **What is left out on purpose:** billing meter records, Stripe state,
  rate-limit buckets, sessions, and expiring tokens
  (`PRACTICE_EXPORT_SYSTEM_EXCLUSIONS` documents each reason). The `practices`
  row itself is not exported; a restore targets an existing practice.
- **Secrets are sanitized on export:** user password hashes are replaced with
  a placeholder (restored staff must reset their passwords), client portal
  tokens are cleared, API keys are disabled, webhook secrets are replaced and
  webhooks arrive deactivated.
- **File binaries are not in the JSON.** The `files` section holds the
  database rows that point at object-storage keys. Object storage is
  independent of the database, so a database loss does not touch the file
  binaries and restored rows point at them correctly.

Admins can also download the identical payload on demand:
**Settings → Data → Export Full Backup**.

## Restore runbook (database loss)

Scenario: the database is gone or a practice's data must be rebuilt from a
snapshot. Wall-clock times from the 2026-07-10 drill are in brackets.

1. **Stand up a database with the current schema** (skip if the database is
   fine and you are only rebuilding one practice):

   ```sh
   cd packages/db
   DATABASE_URL=<target> pnpm run db:migrate   # [~2s]
   DATABASE_URL=<target> pnpm run db:rls       # [~1s]
   ```

2. **Fetch the practice's latest backup** from object storage. There is no
   in-product download of stored snapshots yet, so pull it with any S3
   client using the deployment's `S3_*` credentials:

   ```
   GET {S3_ENDPOINT}/{S3_BUCKET}/backups/{practiceId}/{YYYY-MM-DD}.json
   ```

   (An admin's on-demand **Export Full Backup** file works the same way if
   you have one from before the incident.)

3. **Register a fresh practice** on the app and log in as its admin. [~4s]

4. **Remove the sample data.** New practices are seeded with sample pets so
   the first minutes feel real, and the restore refuses any practice that
   already has clients, patients, appointments, or invoices.
   **Settings → Data → Remove sample data.**

5. **Restore:** **Settings → Data → Restore Full Backup → Choose Backup
   JSON.** The dry run happens automatically and shows verified row counts
   without writing anything. [~2s] Check the fresh-practice confirmation,
   then **Restore into Fresh Practice**. [under 1s for a small clinic]

6. **Verify:** client list, one patient chart (vaccinations tab), one
   invoice. Row counts in the success box should match the dry-run counts.

7. **After-restore hygiene** (by design, see sanitization above):
   - Staff accounts exist but need password resets.
   - Webhooks are disabled with placeholder secrets; re-enable after rotating.
   - API keys are disabled; issue new ones.
   - Reconnect payment processing (Stripe state is not replayed).

The restore is transactional and additive: it validates sections and
cross-references first, inserts everything in one transaction, and skips rows
that already exist. Backups up to 50 MB of JSON are accepted.

## Repeatable drill

`e2e/restore-drill.spec.ts` automates the whole runbook against a scratch
database and is skipped unless `RESTORE_DRILL_BACKUP` is set:

```sh
# scratch DB + dev server pointed at it, then:
RESTORE_DRILL_BACKUP=/path/to/backup.json \
PLAYWRIGHT_BASE_URL=http://localhost:3009 \
pnpm exec playwright test e2e/restore-drill.spec.ts
```

It registers a practice, removes sample data, uploads the backup, checks the
dry run, restores, and verifies restored clients and a patient chart in the
UI, printing phase timings at the end.

## Drill log

### 2026-07-10 (first drill)

- **Scenario:** simulated total database loss. Fresh Postgres database,
  schema from the migration chain, RLS applied, brand-new practice via the
  real registration flow, restore through the Settings UI.
- **Source backup:** the daily cron's real output for a working practice
  (Aspen Creek Animal Hospital, 113 rows across 17 sections, 49.5 KB JSON).
  Cron swept 7 practices in about 1 second.
- **Result: PASS.** All 113 of 113 rows restored. Database-level counts
  matched the export section by section, and the restored patient chart
  (including imported vaccine history) rendered correctly.
- **Timings:** register 4.2s, upload + dry run 1.7s, live restore 0.4s.
  Whole drill including browser startup: 26s.
- **Found and fixed a release blocker:** restores of real backup files
  crashed (`value.toISOString is not a function`). Backups round-trip through
  JSON so timestamps arrive as strings, but the insert path expected `Date`
  objects. The export/download side was always fine; only restore was
  affected. Fixed in `coerceRowDates` (`apps/web/lib/backup/export.ts`) with
  a regression test, and this drill now guards the whole path.
- **Runbook step discovered:** seeded sample data blocks the fresh-practice
  restore. Documented above (step 4); a clearer in-product hint on the
  restore error is a candidate follow-up.
- **Known gap:** no in-product way to list or download the stored daily
  snapshots; retrieval is a manual S3 pull (step 2). Candidate follow-up.
- **Known gap:** file binaries exist only in object storage. Fine for
  database loss; object-storage loss is not covered by these backups.
