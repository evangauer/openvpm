# File and Object Recovery Runbook

This runbook covers OpenVPM attachment and per-practice database-backup
recovery across an independent object-storage failure domain. The feature is
not considered operational until every item in **Activation gate** has passed.

## Recovery boundary

The primary store remains the normal read/write path. Clinic uploads commit
once to primary storage and the database; they do not wait on a second
provider. A scheduled worker then:

1. finds every active file without a fresh independent copy;
2. leases work with `FOR UPDATE SKIP LOCKED` so concurrent jobs do not race;
3. reads and verifies the primary object against its SHA-256/size manifest;
4. writes a content-addressed replica under
   `attachments/v1/{practiceId}/{fileId}/{sha256}`;
5. reads the replica back and verifies its bytes;
6. writes the checksum-addressed catalog evidence at
   `recovery-catalog/v2/{practiceId}/{fileId}/{catalogSha256}.json`; and
7. records the transition in the append-only `file_storage_events` ledger.

The daily per-practice JSON backup is also copied and read-back verified at
`database-backups/v2/{practiceId}/{YYYY-MM-DD}/{backupSha256}.json`, with an
independently versioned checksum-addressed catalog. Backup format v6 contains a
sanitized clinic identity/configuration snapshot plus portable file manifests.
It excludes storage-provider ETags/version IDs, replica projections, Stripe
provider IDs, messaging dispatch authority, and capability tokens.

## Independent target requirements

The replica must not share the primary store's account, bucket, credentials,
deletion authority, or operational blast radius. Before adding any hosted env:

- block all public access and require encryption at rest and TLS;
- enable versioning;
- enable immutable retention/Object Lock in governance or compliance mode;
- give the runtime only list, read, and create/overwrite permissions for its
  prefixes—no object/version delete and no bucket-policy administration;
- retain attachment and recovery-catalog objects for the life of the active
  clinic record; do not attach an expiry rule to those prefixes;
- retain daily database backups for at least 35 days, with longer retention
  chosen against the clinic record-retention policy;
- store break-glass recovery credentials outside Vercel and outside the
  primary provider account; and
- configure billing/spend alerts and provider health notifications.

The runtime verifies reachability but cannot prove account independence,
versioning, immutability, or IAM deletion denial. Record those provider-console
checks in the drill evidence.

## Hosted configuration

Do not set a partial storage configuration. Setting any replica value makes
hosted readiness fail until the complete target is valid. A complete target
can be staged with execution disabled and will perform no replica writes.

```env
FILE_REPLICA_REQUIRED=true
FILE_REPLICA_ENABLED=false
FILE_REPLICA_ALL_PRACTICES=false
FILE_REPLICA_PRACTICE_IDS=<confirmed-pilot-practice-uuid>
FILE_REPLICA_S3_ENDPOINT=... # omit only for AWS S3
FILE_REPLICA_S3_REGION=...
FILE_REPLICA_S3_ACCESS_KEY=...
FILE_REPLICA_S3_SECRET_KEY=...
FILE_REPLICA_S3_BUCKET=...
CRON_HEARTBEAT_FILE_REPLICAS_URL=...
```

The target must resolve to a different endpoint/bucket identity from the
primary. After staging the configuration:

1. run the count-only
   `packages/db/preflight/0077_file_recovery.sql` query against production and
   demo and retain the output in the release evidence. Every blocking count
   must be zero; `patient_id_backfills` and
   `appointment_patient_id_backfills` are informational counts that migration
   0077 repairs deterministically;
2. deploy migrations 0077-0080 as a migration-only release with replica
   execution disabled; these add existing-table constraints `NOT VALID`, so
   new writes are protected without a full-table validation lock;
3. verify migrations, RLS, indexes, and constraint presence in both databases;
4. rerun the preflight, verify the informational backfill counts have fallen to
   zero, and validate the staged constraints in a later reviewed migration;
5. only then deploy the application worker code;
6. require `/api/health` to report the replica check healthy;
7. keep `FILE_REPLICA_ENABLED=false` and confirm the cron reports staged but
   performs no database or object-provider writes;
8. set `FILE_REPLICA_ENABLED=true` for one explicitly confirmed practice UUID;
9. manually invoke the authenticated `/api/cron/file-replicas` route;
10. confirm the cohort backlog falls to zero and fresh coverage reaches 100%;
11. complete the isolated drill before widening the UUID cohort; and
12. use `FILE_REPLICA_ALL_PRACTICES=true` only after rollout approval, with
    `FILE_REPLICA_PRACTICE_IDS` empty.

## Normal operations and alert thresholds

The worker runs every five minutes. A copy is counted available only when its
checksum/size evidence is present and its verification is less than 24 hours
old. Expected steady state:

- fresh coverage: 100%;
- backlog: zero, except briefly after uploads;
- source missing/corrupt: zero;
- failed attempts: zero or self-clearing on the next retry; and
- heartbeat delay: less than 15 minutes.

Page the operator when a run reports a missing/corrupt source, verified
coverage remains below 100% for 30 minutes, the backlog grows for three runs,
or the heartbeat is late. Provider errors use bounded retries and preserve
prior verified evidence; a definitive missing or checksum mismatch downgrades
the affected copy.

## Recovery procedures

### Primary object missing, database healthy

The reconciliation worker verifies the independent object, restores the exact
primary key, reads it back, updates the primary manifest, and alerts operations.
The same-origin file proxy may serve a checksum-verified replica while the
primary is unavailable; it never serves an unverified or corrupt copy.

After an automatic repair, verify the file through the clinic UI and confirm a
`primary_restored_from_replica` storage event exists. Do not delete the replica.

### Database healthy, primary provider unavailable

Leave the primary configuration unchanged while provider status is uncertain.
Verified replica reads keep clinic files available through the app. Pause any
manual migration that could create competing object keys. Recover or replace
the primary provider, then let reconciliation restore missing objects and
verify coverage.

### Database and primary object store lost

1. Isolate a new database and apply the full migration and RLS chain.
2. List the latest
   `database-backup-catalog/v2/{practiceId}/{YYYY-MM-DD}/...json` entry on the
   independent target. Verify the catalog bytes, then fetch its immutable,
   checksum-addressed `database-backups/v2/...` object and verify checksum,
   byte size, ETag/version evidence, and the embedded export timestamp.
3. Use the backup's top-level `practice` snapshot to recreate the original
   practice ID through a reviewed database-owner recovery procedure. Never
   replay Stripe IDs, paid status, calendar tokens, API credentials, webhook
   secrets, or messaging provider authority without external reconciliation.
4. Restore the clinic JSON into that same practice ID using the existing dry
   run and transactional restore path.
5. Configure an empty replacement primary bucket and the independent target.
6. Run reconciliation. It materializes replica projections from file manifests
   and restores each checksum-verified object to its original primary key.
7. Verify database row counts, one attachment in every category, one signed
   consent, one patient photo/document, one clinic logo, billing state against
   Stripe, and messaging state against the provider.

The database-owner practice-shell procedure and combined-loss drill must be
completed before this scenario is declared supported. Do not improvise IDs or
weaken foreign keys/RLS during an incident.

## Destructive drill

Run only with synthetic data and isolated primary/replica buckets.

1. Create a scratch clinic with a logo, patient photo, document, lab file, and
   signed consent; record SHA-256 and byte size for each.
2. Run the backup and replica workers to 100% fresh coverage.
3. Deny or remove access to the scratch primary bucket.
4. Verify every file still reads through the app from the replica.
5. Restore a scratch database from the independent database JSON using the
   original synthetic practice ID.
6. Point the scratch environment at a new empty primary bucket and run the
   worker until every object is restored and verified.
7. Compare all bytes/checksums and clinical row counts, then exercise the
   object-version recovery path.
8. Prove the runtime credential cannot delete either current objects or
   retained versions.

Pass criteria: no lost bytes or rows, 100% fresh replica coverage, primary
reconstruction completes without hand-editing manifests, app reads remain
tenant-authorized, all expected alerts/heartbeats arrive, and actual RTO/RPO
are recorded. Keep the drill log free of clinic PII and credentials.

## Activation gate

The replica is launch-ready only after:

- code, migration, RLS, unit, integration, build, and production smoke checks
  are green;
- Evan approves the independent provider/account and any resulting spend;
- bucket independence, encryption, versioning, immutability, IAM, retention,
  and spend alerts are evidenced;
- production backfill reaches 100% fresh coverage;
- an isolated combined database/primary-loss drill passes; and
- the runbook records RPO, RTO, drill date, and operator.

Until then, leave `FILE_REPLICA_ENABLED=false`. Credentials may be staged only
after the independent bucket controls are evidenced; keep
`FILE_REPLICA_REQUIRED=false` until the operational gate is complete. Track the
remaining gate in OPENVPM-41.

## Release evidence — 2026-08-10

The count-only preflight was run read-only against the hosted production and
demo databases before migration 0077:

- production: every blocking count was zero; both informational backfill
  counts were zero;
- demo: every blocking count was zero;
  `patient_id_backfills` was 4 and is deterministically repaired by migration
  0077; `appointment_patient_id_backfills` was zero.

This evidence permits the migration-only staging release. It does not permit
the application worker to run: constraint validation, post-migration drift/RLS
checks, independent-provider controls, and the destructive synthetic drill are
still required.
