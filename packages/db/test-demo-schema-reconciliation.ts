import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;
type MigrationJournalEntry = { idx: number; tag: string };

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function expectRejected(
  label: string,
  operation: () => Promise<unknown>,
  message?: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (message && !message.test(detail)) {
      throw new Error(`${label} failed for the wrong reason: ${detail}`);
    }
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

const adminUrl = requiredEnv("DATABASE_URL");
const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "drizzle");
const canonicalMigrationTag = "0100_small_kylun";
const identityRotationMigrationTag = "0101_colorful_stark_industries";
const canonicalMigrationFile = `${canonicalMigrationTag}.sql`;
const identityRotationMigrationFile = `${identityRotationMigrationTag}.sql`;
const canonicalMigration = readFileSync(
  join(migrationDir, canonicalMigrationFile),
  "utf8",
);
const identityRotationMigration = readFileSync(
  join(migrationDir, identityRotationMigrationFile),
  "utf8",
);
const rogueFixture = readFileSync(
  join(here, "fixtures", "demo-rogue-0099-0101.sql"),
  "utf8",
);
const rlsBaseline = readFileSync(join(here, "rls", "enable-rls.sql"), "utf8");
const migrationJournal = JSON.parse(
  readFileSync(join(migrationDir, "meta", "_journal.json"), "utf8"),
) as { entries?: unknown };
if (!Array.isArray(migrationJournal.entries)) {
  throw new Error("Drizzle migration journal has no entries array");
}
const journalEntries = migrationJournal.entries.map((entry, position) => {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("idx" in entry) ||
    !("tag" in entry) ||
    typeof entry.idx !== "number" ||
    entry.idx !== position ||
    typeof entry.tag !== "string" ||
    !/^\d{4}_.+$/.test(entry.tag)
  ) {
    throw new Error(`invalid Drizzle migration journal entry at ${position}`);
  }
  return { idx: entry.idx, tag: entry.tag } satisfies MigrationJournalEntry;
});
const journalMigrationFiles = journalEntries.map((entry) => `${entry.tag}.sql`);
const directoryMigrationFiles = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort((left, right) => left.localeCompare(right, "en"));
const sortedJournalMigrationFiles = [...journalMigrationFiles].sort(
  (left, right) => left.localeCompare(right, "en"),
);
if (
  directoryMigrationFiles.length !== sortedJournalMigrationFiles.length ||
  directoryMigrationFiles.some(
    (migrationFile, index) =>
      migrationFile !== sortedJournalMigrationFiles[index],
  )
) {
  throw new Error(
    "Drizzle journal and canonical migration files do not have exact coverage",
  );
}
const canonicalAnchorIndexes = journalEntries.flatMap((entry, index) =>
  entry.tag === canonicalMigrationTag ? [index] : [],
);
const identityAnchorIndexes = journalEntries.flatMap((entry, index) =>
  entry.tag === identityRotationMigrationTag ? [index] : [],
);
if (
  canonicalAnchorIndexes.length !== 1 ||
  identityAnchorIndexes.length !== 1 ||
  identityAnchorIndexes[0] !== canonicalAnchorIndexes[0]! + 1
) {
  throw new Error(
    "canonical 0100/0101 migration anchors are missing or ambiguous",
  );
}
const migrationsThroughMain0099 = journalMigrationFiles.slice(
  0,
  canonicalAnchorIndexes[0],
);
const migrationsAfterIdentityRotation = journalMigrationFiles.slice(
  identityAnchorIndexes[0]! + 1,
);
const safeIdentifier = /^[a-z][a-z0-9_]+$/;
const admin = postgres(adminUrl, { max: 1 });
let createdAppRole = false;

async function applyMigration(
  owner: SqlClient,
  migrationSql: string,
): Promise<void> {
  await owner.begin(async (transaction) => {
    await (transaction as unknown as SqlClient).unsafe(migrationSql).simple();
  });
}

async function applyCanonical(owner: SqlClient): Promise<void> {
  await applyMigration(owner, canonicalMigration);
}

async function applyIdentityRotation(owner: SqlClient): Promise<void> {
  await applyMigration(owner, identityRotationMigration);
}

async function applyCanonicalTail(owner: SqlClient): Promise<void> {
  const tailMigrations = migrationsAfterIdentityRotation.map(
    (migrationFile) => ({
      migrationFile,
      migrationSql: readFileSync(join(migrationDir, migrationFile), "utf8"),
    }),
  );
  await owner.begin(async (transaction) => {
    const scoped = transaction as unknown as SqlClient;
    for (const migration of tailMigrations) {
      await scoped.unsafe(migration.migrationSql).simple();
    }
  });
}

async function runScenario(kind: "fresh" | "rogue"): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `op_reconcile_${kind}_${suffix}`;
  const ownerRole = `op_rec_owner_${kind[0]}_${suffix}`;
  const ownerPassword = randomUUID();

  for (const identifier of [databaseName, ownerRole]) {
    if (!safeIdentifier.test(identifier) || identifier.length > 63) {
      throw new Error("unsafe disposable PostgreSQL identifier");
    }
  }

  const targetAdminUrl = new URL(adminUrl);
  targetAdminUrl.pathname = `/${databaseName}`;
  targetAdminUrl.search = "";
  targetAdminUrl.hash = "";

  const targetOwnerUrl = new URL(targetAdminUrl);
  targetOwnerUrl.username = ownerRole;
  targetOwnerUrl.password = ownerPassword;

  let owner: SqlClient | undefined;
  let targetAdmin: SqlClient | undefined;
  let ownerRoleCreated = false;
  let databaseCreated = false;

  try {
    await admin.unsafe(
      `create role "${ownerRole}" login password '${ownerPassword}'`,
    );
    ownerRoleCreated = true;
    await admin.unsafe(
      `create database "${databaseName}" owner "${ownerRole}"`,
    );
    databaseCreated = true;

    owner = postgres(targetOwnerUrl.toString(), { max: 1 });
    for (const migrationFile of migrationsThroughMain0099) {
      await owner
        .unsafe(readFileSync(join(migrationDir, migrationFile), "utf8"))
        .simple();
    }

    const practiceId = randomUUID();
    await owner`insert into practices (id, name)
      values (${practiceId}, ${`Reconciliation ${kind}`})`;
    await owner`insert into users
      (id, email, password_hash, name, role, practice_id) values
      (${randomUUID()}, 'reconciliation-active@example.test', 'test', 'Active fixture', 'admin', ${practiceId}),
      (${randomUUID()}, 'reconciliation-pending@example.test', 'test', 'Pending fixture', 'admin', ${practiceId}),
      (${randomUUID()}, 'reconciliation-empty@example.test', 'test', 'Empty fixture', 'admin', ${practiceId})`;

    if (kind === "rogue") {
      await owner.unsafe(rogueFixture).simple();
    }

    const backupBefore =
      kind === "rogue"
        ? await owner`select * from backup_runs order by id`
        : [];
    const mfaBefore =
      kind === "rogue"
        ? await owner`select email, mfa_secret_encrypted, mfa_enabled_at,
            mfa_last_used_totp_counter, mfa_recovery_code_hashes,
            mfa_pending_secret_encrypted, mfa_pending_expires_at
          from users order by email`
        : [];

    // Applying the canonical migration twice proves the SQL accepts the exact
    // adopted shape and performs no second-pass mutation.
    await applyCanonical(owner);
    await applyCanonical(owner);
    // The next canonical migration must apply cleanly after both fresh and
    // adopted demo schema paths without disturbing reconciled evidence.
    await applyIdentityRotation(owner);
    // The RLS baseline is intentionally strict about every current table.
    // Discover and apply the complete journal-ordered canonical tail in one
    // transaction so later migrations cannot be skipped or partially applied.
    await applyCanonicalTail(owner);
    // Prove the idempotent full RLS baseline retains the migration's narrower
    // backup-run privilege override after its initial all-table grant.
    await owner.unsafe(rlsBaseline).simple();

    const [shape] = await owner<
      Array<{
        backupRows: number;
        mfaColumns: number;
        mfaConstraints: number;
        enumLabels: string[];
        rowSecurity: boolean;
        identityRotationColumns: number;
        identityRotationConstraints: number;
        aliasConstraints: number;
        aliasUniqueIndexes: number;
        aliasRowSecurity: boolean;
      }>
    >`select
      (select count(*)::int from backup_runs) as "backupRows",
      (select count(*)::int from information_schema.columns
        where table_schema = 'public' and table_name = 'users'
          and column_name like 'mfa\_%' escape '\') as "mfaColumns",
      (select count(*)::int from pg_constraint
        where conrelid = 'public.users'::regclass
          and conname in ('users_mfa_active_shape_check',
            'users_mfa_pending_shape_check', 'users_mfa_totp_counter_check')
          and convalidated) as "mfaConstraints",
      (select array_agg(e.enumlabel order by e.enumsortorder)
        from pg_enum e
        where e.enumtypid = 'public.backup_run_status'::regtype) as "enumLabels",
      (select relrowsecurity from pg_class
        where oid = 'public.backup_runs'::regclass) as "rowSecurity",
      (select count(*)::int from information_schema.columns
        where table_schema = 'public'
          and table_name = 'platform_email_identity'
          and column_name in ('previous_identity_key_fingerprint',
            'rotation_started_at')) as "identityRotationColumns",
      (select count(*)::int from pg_constraint
        where conrelid = 'public.platform_email_identity'::regclass
          and conname in ('platform_email_identity_previous_fingerprint_check',
            'platform_email_identity_distinct_fingerprints_check',
            'platform_email_identity_rotation_state_check')
          and convalidated) as "identityRotationConstraints",
      (select count(*)::int from pg_constraint
        where conrelid = 'public.platform_email_identity_aliases'::regclass
          and conname in (
            'platform_email_identity_aliases_current_fingerprint_check',
            'platform_email_identity_aliases_current_hash_check',
            'platform_email_identity_aliases_previous_fingerprint_check',
            'platform_email_identity_aliases_previous_hash_check',
            'platform_email_identity_aliases_distinct_fingerprints_check',
            'platform_email_identity_aliases_distinct_hashes_check')
          and convalidated) as "aliasConstraints",
      (select count(*)::int from pg_index i
        join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'public.platform_email_identity_aliases'::regclass
          and i.indisunique
          and c.relname in ('platform_email_identity_aliases_current_uq',
            'platform_email_identity_aliases_previous_uq')) as "aliasUniqueIndexes",
      (select relrowsecurity from pg_class
        where oid = 'public.platform_email_identity_aliases'::regclass)
        as "aliasRowSecurity"`;

    const expectedBackupRows = kind === "rogue" ? 3 : 0;
    if (
      shape?.backupRows !== expectedBackupRows ||
      shape.mfaColumns !== 6 ||
      shape.mfaConstraints !== 3 ||
      JSON.stringify(shape.enumLabels) !==
        JSON.stringify(["ok", "degraded", "failed"]) ||
      !shape.rowSecurity ||
      shape.identityRotationColumns !== 2 ||
      shape.identityRotationConstraints !== 3 ||
      shape.aliasConstraints !== 6 ||
      shape.aliasUniqueIndexes !== 2 ||
      !shape.aliasRowSecurity
    ) {
      throw new Error(
        `${kind} reconciliation shape mismatch: ${JSON.stringify(shape)}`,
      );
    }

    const mfaAfter = await owner`select email, mfa_secret_encrypted,
      mfa_enabled_at, mfa_last_used_totp_counter, mfa_recovery_code_hashes,
      mfa_pending_secret_encrypted, mfa_pending_expires_at
      from users order by email`;
    if (kind === "rogue") {
      const backupAfter = await owner`select * from backup_runs order by id`;
      if (JSON.stringify(backupAfter) !== JSON.stringify(backupBefore)) {
        throw new Error("canonical migration changed existing backup evidence");
      }
      if (JSON.stringify(mfaAfter) !== JSON.stringify(mfaBefore)) {
        throw new Error("canonical migration changed existing MFA values");
      }
    } else if (
      mfaAfter.some((row) =>
        Object.entries(row).some(
          ([column, value]) => column !== "email" && value !== null,
        ),
      )
    ) {
      throw new Error("fresh reconciliation populated dormant MFA values");
    }

    targetAdmin = postgres(targetAdminUrl.toString(), { max: 1 });
    const [privileges] = await targetAdmin<
      Array<{
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
        publicSelect: boolean;
        aliasSelect: boolean;
        aliasInsert: boolean;
        aliasUpdate: boolean;
        aliasDelete: boolean;
        publicAliasSelect: boolean;
      }>
    >`select
      has_table_privilege('openpims_app', 'public.backup_runs', 'select') as "select",
      has_table_privilege('openpims_app', 'public.backup_runs', 'insert') as "insert",
      has_table_privilege('openpims_app', 'public.backup_runs', 'update') as "update",
      has_table_privilege('openpims_app', 'public.backup_runs', 'delete') as "delete",
      has_table_privilege('openpims_app', 'public.platform_email_identity_aliases', 'select') as "aliasSelect",
      has_table_privilege('openpims_app', 'public.platform_email_identity_aliases', 'insert') as "aliasInsert",
      has_table_privilege('openpims_app', 'public.platform_email_identity_aliases', 'update') as "aliasUpdate",
      has_table_privilege('openpims_app', 'public.platform_email_identity_aliases', 'delete') as "aliasDelete",
      exists (
        select 1 from information_schema.role_table_grants
        where grantee = 'PUBLIC'
          and table_schema = 'public'
          and table_name = 'backup_runs'
          and privilege_type = 'SELECT'
      ) as "publicSelect",
      exists (
        select 1 from information_schema.role_table_grants
        where grantee = 'PUBLIC'
          and table_schema = 'public'
          and table_name = 'platform_email_identity_aliases'
          and privilege_type = 'SELECT'
      ) as "publicAliasSelect"`;
    if (
      !privileges?.select ||
      !privileges.insert ||
      privileges.update ||
      privileges.delete ||
      privileges.publicSelect ||
      !privileges.aliasSelect ||
      !privileges.aliasInsert ||
      privileges.aliasUpdate ||
      privileges.aliasDelete ||
      privileges.publicAliasSelect
    ) {
      throw new Error(
        `unsafe backup_runs privileges: ${JSON.stringify(privileges)}`,
      );
    }

    const noContextRows = await targetAdmin.begin(async (transaction) => {
      const scoped = transaction as unknown as SqlClient;
      await scoped.unsafe("set local role openpims_app");
      return scoped`select id from backup_runs`;
    });
    if (noContextRows.length !== 0) {
      throw new Error("backup_runs no-context read did not fail closed");
    }

    const systemRows = await targetAdmin.begin(async (transaction) => {
      const scoped = transaction as unknown as SqlClient;
      await scoped.unsafe("set local role openpims_app");
      await scoped`select set_config('app.rls_bypass', 'on', true)`;
      return scoped`select id from backup_runs order by id`;
    });
    if (systemRows.length !== expectedBackupRows) {
      throw new Error(
        "backup_runs system-context read did not expose exact evidence",
      );
    }

    await expectRejected("no-context backup insert", () =>
      targetAdmin!.begin(async (transaction) => {
        const scoped = transaction as unknown as SqlClient;
        await scoped.unsafe("set local role openpims_app");
        await scoped`insert into backup_runs
          (started_at, completed_at, run_date_utc, status, practices,
           primary_verified, primary_failed, oversized, near_limit,
           max_export_bytes, replica_enabled, replica_required,
           replica_verified, replica_failed)
          values (now(), now(), current_date, 'ok', 0, 0, 0, 0, 0, 0,
            false, false, 0, 0)`;
      }),
    );
    await expectRejected("system-context backup update", () =>
      targetAdmin!.begin(async (transaction) => {
        const scoped = transaction as unknown as SqlClient;
        await scoped.unsafe("set local role openpims_app");
        await scoped`select set_config('app.rls_bypass', 'on', true)`;
        await scoped`update backup_runs set near_limit = near_limit`;
      }),
    );

    if (kind === "fresh") {
      await owner`alter table backup_runs add constraint
        backup_runs_incompatible_test_check check (practices < 1000000)`;
      await expectRejected(
        "incompatible backup shape preflight",
        () => applyCanonical(owner!),
        /unexpected constraint backup_runs_incompatible_test_check/,
      );
    }

    console.log(
      `✓ ${kind}: canonical 0100 + 0101 preserved data, ${migrationsAfterIdentityRotation.length} tail migrations applied, and current system-only RLS enforced`,
    );
  } finally {
    if (targetAdmin) await targetAdmin.end();
    if (owner) await owner.end();
    if (databaseCreated) {
      await admin.unsafe(`drop database "${databaseName}" with (force)`);
    }
    if (ownerRoleCreated) {
      await admin.unsafe(`drop role "${ownerRole}"`);
    }
  }
}

try {
  const [appRole] =
    await admin`select 1 from pg_roles where rolname = 'openpims_app'`;
  if (!appRole) {
    await admin.unsafe("create role openpims_app nologin");
    createdAppRole = true;
  }

  await runScenario("fresh");
  await runScenario("rogue");
  console.log(
    "Demo schema reconciliation PostgreSQL contract passed: fresh-main and exact rogue 0099-0101 upgrades through the current canonical tail are lossless and fail closed.",
  );
} finally {
  if (createdAppRole) {
    await admin.unsafe("drop role openpims_app");
  }
  await admin.end();
}
