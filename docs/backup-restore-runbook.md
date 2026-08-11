# Backup and Restore Runbook

OpenVPM Cloud takes a structured database backup of every practice every day.
This runbook covers what is in those JSON backups, how to restore one, and the
drill log for the database path. Attachment-binary disaster recovery is defined
in [File and Object Recovery Runbook](file-object-recovery-runbook.md) and
remains a launch gate until its independent target, backfill, and destructive
drill pass.

## What gets backed up

- **When:** daily at 3:00 AM UTC (`/api/cron/backup`, see `apps/web/vercel.json`).
- **Database snapshot:** each practice export runs in its own read-only
  `REPEATABLE READ` transaction so every section and canonical count describes
  one consistent point-in-time view.
- **Where:** object storage, one file per practice per day:
  `backups/{practiceId}/{YYYY-MM-DD}.json` (date in the practice's timezone).
- **What:** every practice-owned table, active rows only. That includes the
  full clinical record (persisted SOAP drafts, immutable finalized SOAP notes
  with attribution, SOAP corrections and addenda, clinical notes, vitals, vaccinations,
  labs plus their immutable completion/review/follow-up history, procedures,
  prescriptions, problem lists, cases, treatment plans,
  controlled-substance log), clients and patients, scheduling, billing
  (invoices, items, payments, adjustments, claims), inventory, staff, and the
  audit log. The canonical section list is `PRACTICE_EXPORT_SECTIONS` in
  `apps/web/lib/backup/export.ts`.
- **Recovery identity:** format v6 includes a sanitized top-level `practice`
  snapshot for a reviewed database-owner bootstrap. It preserves the original
  practice UUID and safe clinic settings, but excludes Stripe IDs, provider
  authority, calendar tokens, secrets, and paid status.
- **What is left out on purpose:** billing meter records, Stripe state,
  rate-limit buckets, sessions, and expiring tokens
  (`PRACTICE_EXPORT_SYSTEM_EXCLUSIONS` documents each reason). The `practices`
  row itself is not exported; a restore targets an existing practice.
- **SMS provider ledgers are audit-only in the JSON:** durable send attempts,
  provider outcomes, delivery callbacks, and tenant-attributed attribution,
  projection, and operator-reconciliation history are included for clinic
  audit and portability. Platform-global quarantine, identity-conflict, and
  review rows are excluded from the clinic-admin export. Ordinary clinic
  restore intentionally inserts none of those four sections. They contain
  environment-bound provider identities and acceptance authority that must not
  be replayed into another practice or installation. Ordinary communications
  remain restorable. `PRACTICE_EXPORT_AUDIT_ONLY_SECTIONS` documents this
  boundary.
- **Secrets are sanitized on export:** user password hashes are replaced with
  a placeholder (restored staff must reset their passwords), client portal
  tokens are cleared, API keys are disabled, webhook secrets are replaced and
  webhooks arrive deactivated.
- **File binaries are not in the JSON.** The `files` section holds attachment
  manifests only. Format v6 includes a sanitized top-level `practice` recovery
  snapshot and the manifests include checksum, byte size, patient/visit links,
  and document metadata. Provider ETags/version IDs, replica projections, and
  storage transition events remain outside clinic JSON. A same-practice
  database recovery can reuse surviving objects or independently retained
  copies. A fresh-practice restore with file manifests is rejected because its
  source-practice keys would be unusable.
- **Independent evidence:** when the controlled replica rollout includes the
  practice, the cron also writes a checksum-addressed JSON object beneath
  `database-backups/v2/{practiceId}/{YYYY-MM-DD}/` and a checksum-addressed
  catalog beneath `database-backup-catalog/v2/...`. Both are read back and
  checksum-verified before the independent copy is counted successful. The
  catalog records the exact provider version ID of the backup object. The
  export is rejected before upload if it exceeds the same 50 MB restore cap.
  Backup heartbeat metrics distinguish `oversized` exports from
  `otherFailed`, count exports at or above 80% of the cap as `nearLimit`, and
  report `maxExportBytes` against `backupMaxBytes` for capacity planning.

Admins can also download the identical payload on demand:
**Settings → Data → Export Database Backup**.

## Owner artifact-integrity verification (offline)

Before a restore or disaster drill, a database/storage owner can verify a
downloaded independent backup and its catalog without connecting this tool to
storage or writing any application state. Work in a temporary directory
outside the repository; never commit clinic backup JSON.

1. Select one checksum-addressed catalog key beneath
   `database-backup-catalog/v2/{practiceId}/{YYYY-MM-DD}/`. Download that
   catalog by an explicit provider version when the storage provider exposes
   versioning.
2. Read `objectKey` and `objectVersionId` from the catalog, then download that
   exact backup object version. Do not substitute the current/latest object.
3. Run the local verifier from `apps/web`:

   ```sh
   pnpm backup:verify-evidence -- \
     --catalog /tmp/openvpm-recovery/catalog.json \
     --catalog-key 'database-backup-catalog/v2/PRACTICE_ID/YYYY-MM-DD/CATALOG_SHA256.json' \
     --object /tmp/openvpm-recovery/backup.json \
     --expected-practice 'PRACTICE_ID' \
     --expected-date 'YYYY-MM-DD'
   ```

The command is intentionally read-only and offline. It bounds both local
files, verifies the catalog's content-addressed key, requires the catalog's
exact backup-object version ID, checks the backup bytes/size/checksum, and
requires the one supported canonical export format and its complete section
counts to equal the actual section-array lengths. Its JSON output inventories
only recovery evidence and counts; it does not print clinical rows. A
successful result has `status: "artifact_integrity_verified"`,
`verificationScope: "artifact_integrity_and_canonical_counts"`,
`applicationRestoreValidationPerformed: false`, and
`restorePerformed: false`.

Stop on any verifier error. Do not edit either JSON file to make it pass, do
not restore an unverified object, and do not weaken the 50 MB bound. This
artifact-integrity check proves the downloaded artifacts agree and that their
canonical counts match their arrays. It does not run the application's full
row/cross-reference restore validator and does not replace the transactional
application dry run or the repeatable restore drill below.

## Restore runbook (clinic data recovery)

Scenario: a practice's data must be rebuilt from a JSON snapshot. Wall-clock
times from the 2026-07-10 database-only drill are in brackets. If the whole
database is gone and the backup contains attachment manifests, use the
same-install database snapshot/WAL procedure below. The JSON alone is not yet
a complete recovery source for that incident.

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

   (An admin's on-demand **Export Database Backup** file works the same way if
   you have one from before the incident.)

3. **Choose the empty target practice:**
   - If the backup contains any `files` rows, use only its original practice.
     Stop if that practice identity no longer exists; do not register a
     replacement practice and do not rewrite storage keys by hand.
   - If the backup contains no `files` rows, you may register a fresh practice
     and log in as its admin. [~4s]

4. **Empty the target.** New practices are seeded with sample pets so the
   first minutes feel real, and the restore refuses any practice that already
   has clients, patients, appointments, or invoices.
   **Settings → Data → Remove sample data.**

5. **Restore:** **Settings → Data → Restore Database Backup → Choose Backup
   JSON.** The dry run happens automatically and shows verified row counts
   without writing anything. [~2s] Check the empty-practice confirmation,
   then **Restore into Empty Practice**. [under 1s for a small clinic]

6. **Verify:** client list, one patient chart (vaccinations tab), one
   invoice, and the Lab Inbox review/follow-up evidence for one completed
   result. For a backup containing a lab correction, confirm the retained
   entered-in-error source links bidirectionally to its replacement. Row counts
   in the success box should match the dry-run counts.

7. **After-restore hygiene** (by design, see sanitization above):
   - Staff accounts exist but need password resets.
   - Webhooks are disabled with placeholder secrets; re-enable after rotating.
   - API keys are disabled; issue new ones.
   - Reconnect payment processing (Stripe state is not replayed).
   - Re-provision/reconcile texting before enabling it. SMS send, outcome, and
     delivery ledgers are visible in the source export for audit but are not
     replayed by clinic restore. Durable provider-event inbox rows are global
     operational evidence and are also never imported from clinic JSON.

The restore is additive and fail-closed. It first performs size, section,
cross-reference, and file-target validation without writing. Its first database
mutation then places the active target practice on a recovery hold and commits
that hold independently. Only after other transactions holding an in-flight
provider lock have drained does the bulk insert transaction begin. A bulk
insert failure rolls back restored rows but deliberately leaves the committed
hold active for owner review; it must never silently reopen the clinic. Rows
that already exist are skipped. The hold remains active until the owner
reconciliation procedure explicitly releases it. Backups up to 50 MB of JSON
are accepted.

Hold release is a database-enforced messaging gate, not just the
`--reconciled-messaging` checklist assertion. The owner release transaction
takes the practice row `FOR UPDATE`, keeps `recovery_hold=true`, and attempts up
to 500 attributable pending/retry/recovery-blocked provider events oldest-first.
It then blocks on any remaining attributable pending, retry,
recovery-blocked, or quarantined event, any unreviewed identity conflict, and
any unresolved event received since `recovery_hold_set_at` (the conservative
single-clinic pilot boundary). A blocked release commits successful event
projections and a PHI-free `hold_release_blocked` audit record, but never clears
the hold. Each event projection uses a database savepoint, so a SQL failure
rolls back only that event and does not discard earlier drain progress or the
final blocked-release audit. Rerun only after the redacted queue explains every
remaining item.
The successful `hold_released` audit stores before/after counts, projection
outcomes, the event watermark, and whether the bounded drain filled.

An identity-conflict review does not by itself make a quarantined original event
safe. The review closes only that conflict incident; quarantine continues to
block release and activation until a separate audited remediation establishes a
safe projection. Never use a review to bypass unresolved STOP evidence.

While held, clinic email/SMS/webhook delivery, AI model calls, Stripe checkout,
capture, refund, metering and subscription-quantity mutations, and Telnyx
profile/number/A2P mutations are blocked. These paths take a shared lock on the
practice row through the provider call; recovery's hold update therefore waits
for a provider operation that already started, and no provider operation can
start after the hold commits. Local usage evidence and authenticated inbound
Stripe facts remain durable for later reconciliation.

Intentional exceptions are narrow: password-reset and verification email stay
available so authorized staff can recover access; read-only provider searches
and operator reconciliation reads may inspect authoritative state but may not
mutate it; backup creation and owner-controlled object replication/recovery
remain available because they preserve or repair recovery evidence. Disabling
a sender is safe, but enabling clinic delivery remains blocked until the hold is
released.

For a same-install database disaster, restore the database snapshot/WAL under
the database-owner procedure. That trusted owner-maintenance path preserves the
global SMS ledgers and their provider identities. Do not use the clinic-admin
JSON restore as a substitute, and do not weaken RLS or append-only triggers to
force those rows into a fresh clinic.

## Account-closure retention

Append-only SMS provider ledgers are not automatically pruned while a practice
is active. They contain provider message/event identifiers and may contain a
redacted platform-operator identity, so they are explicitly in scope for
account deletion. After the promised 60-day export window closes, a database
owner must run the reviewed account-closure purge with
`app.ledger_maintenance=on` in one transaction. Delete dependent delivery
history before practice send-attempt history, then delete global delivery
events only when no accepted send attempt in a remaining practice exactly
matches `(provider, providerMessageId)` and no unresolved identity incident
remains. Verify the closed practice has zero send attempts, attempt events,
delivery history, and attributed delivery events before completing the
request. Do not purge a global event that still matches another practice's
accepted send or remains in an identity-conflict investigation, even if it
currently has no attribution. Stored backups then age out under the
account-closure policy; indefinite post-closure retention is not authorized.

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
  snapshots; retrieval is still a manual, owner-authorized object-store pull.
  The local owner verifier now validates the selected checksum/version
  evidence before restore, but does not perform discovery or download.
- **Launch-blocking gap at drill time:** file binaries existed only in primary
  object storage. The independent-copy implementation now has a separate
  activation gate; it is not operationally complete until provider setup,
  backfill, and the combined-loss drill in the file/object runbook pass. Track
  that evidence in OPENVPM-41.
