/**
 * Real-Postgres migration-run concurrency and rollback verification.
 * Run after committed migrations and RLS have been applied.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";
import type { Database } from "./client";
import { clients, migrationRuns } from "./schema/index";
const importedRunLedger =
  (await import("../../apps/web/lib/import/run-ledger")) as unknown as Record<
    string,
    unknown
  >;
const runLedgerModule = (importedRunLedger.default ??
  importedRunLedger["module.exports"] ??
  importedRunLedger) as typeof import("../../apps/web/lib/import/run-ledger");
const {
  claimMigrationPreview,
  completeMigrationRun,
  createMigrationPreview,
  lockMigrationPractice,
} = runLedgerModule;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} not set`);
  return value;
}

function appRoleUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = "openpims_app";
  url.password = process.env.OPENPIMS_APP_DB_PASSWORD?.trim() || "openpims_app";
  return url.toString();
}

const ownerSql = postgres(requiredEnv("DATABASE_URL"), { max: 1 });
const appSql = postgres(appRoleUrl(requiredEnv("DATABASE_URL")), { max: 4 });
const appDb = drizzle(appSql, { schema });
const practiceId = randomUUID();
const userId = randomUUID();
const csv = "firstName,lastName,email\nAda,Clinic,ada@example.com";
const summary = {
  sourceRowCount: 1,
  plannedInsertCount: 1,
  errorCount: 0,
};

async function tenantTransaction<T>(
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_practice_id', ${practiceId}, true)`,
    );
    return fn(tx as unknown as Database);
  });
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  await ownerSql`insert into practices (id, name) values (${practiceId}, 'Migration Run Integration')`;
  await ownerSql`insert into users (id, email, password_hash, name, role, practice_id)
    values (${userId}, ${`migration-${userId}@example.com`}, 'not-a-real-hash', 'Migration Admin', 'admin', ${practiceId})`;

  const [firstPreview, secondPreview] = await Promise.all([
    tenantTransaction((tx) =>
      createMigrationPreview(tx, {
        practiceId,
        createdBy: userId,
        mode: "clients",
        source: "other",
        csv,
        summary,
      }),
    ),
    tenantTransaction((tx) =>
      createMigrationPreview(tx, {
        practiceId,
        createdBy: userId,
        mode: "clients",
        source: "other",
        csv,
        summary,
      }),
    ),
  ]);
  const previewRows = await ownerSql`
    select id, status from migration_runs
    where id in (${firstPreview}, ${secondPreview})
    order by created_at, id`;
  check(previewRows.length === 2, "both concurrent previews must be recorded");
  check(
    previewRows.filter((row) => row.status === "previewed").length === 1,
    "exactly one same-kind preview must remain active",
  );
  check(
    previewRows.filter((row) => row.status === "superseded").length === 1,
    "the older concurrent preview must be superseded",
  );
  const activePreview = previewRows.find((row) => row.status === "previewed")!;

  async function commitOnce() {
    return tenantTransaction(async (tx) => {
      await lockMigrationPractice(tx, practiceId);
      await tx
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.practiceId, practiceId));
      const claim = await claimMigrationPreview(tx, {
        practiceId,
        previewToken: activePreview.id,
        mode: "clients",
        source: "other",
        csv,
        summary,
      });
      if (claim.alreadyCommitted) return claim;
      await tx.insert(clients).values({
        practiceId,
        firstName: "Migration",
        lastName: "Concurrency",
      });
      await completeMigrationRun(tx, {
        practiceId,
        previewToken: activePreview.id,
        importedCount: 1,
        committedBy: userId,
      });
      return claim;
    });
  }

  const commitResults = await Promise.all([commitOnce(), commitOnce()]);
  check(
    commitResults.filter((result) => result.alreadyCommitted).length === 1,
    "one concurrent retry must return the saved committed result",
  );
  const inserted = await ownerSql`
    select id from clients
    where practice_id = ${practiceId} and first_name = 'Migration' and last_name = 'Concurrency'`;
  check(
    inserted.length === 1,
    "concurrent exact commits must write domain rows once",
  );
  const [committedRun] = await ownerSql`
    select status, imported_count from migration_runs where id = ${activePreview.id}`;
  check(
    committedRun?.status === "committed" && committedRun.imported_count === 1,
    "the migration run must commit exactly once",
  );

  const rollbackPreview = await tenantTransaction((tx) =>
    createMigrationPreview(tx, {
      practiceId,
      createdBy: userId,
      mode: "patients",
      source: "other",
      csv,
      summary,
    }),
  );
  let failedWriteRolledBack = false;
  try {
    await tenantTransaction(async (tx) => {
      const claim = await claimMigrationPreview(tx, {
        practiceId,
        previewToken: rollbackPreview,
        mode: "patients",
        source: "other",
        csv,
        summary,
      });
      check(
        !claim.alreadyCommitted,
        "fresh rollback test preview must be claimable",
      );
      await tx.execute(
        sql`insert into clients (practice_id, last_name) values (${practiceId}, 'Invalid')`,
      );
    });
  } catch {
    failedWriteRolledBack = true;
  }
  check(
    failedWriteRolledBack,
    "the forced domain constraint failure must throw",
  );
  const [rolledBackRun] = await ownerSql`
    select status from migration_runs where id = ${rollbackPreview}`;
  check(
    rolledBackRun?.status === "previewed",
    "a failed domain write must roll the preview claim back",
  );

  let mismatchRejected = false;
  try {
    await tenantTransaction((tx) =>
      claimMigrationPreview(tx, {
        practiceId,
        previewToken: activePreview.id,
        mode: "clients",
        source: "other",
        csv: `${csv}\n`,
        summary,
      }),
    );
  } catch {
    mismatchRejected = true;
  }
  check(
    mismatchRejected,
    "an exact-byte mismatch must reject the committed token",
  );

  console.log(
    "✓ migration preview concurrency, idempotency, rollback, and exact-file checks passed",
  );
} finally {
  await ownerSql`delete from clients where practice_id = ${practiceId}`;
  await ownerSql`delete from migration_runs where practice_id = ${practiceId}`;
  await ownerSql`delete from users where id = ${userId}`;
  await ownerSql`delete from practices where id = ${practiceId}`;
  await appSql.end();
  await ownerSql.end();
}
