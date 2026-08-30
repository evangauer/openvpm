import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY } from "./migration-conformance";

type Journal = {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

type Fixture = {
  name: "fresh" | "production" | "staging";
  through: number | null;
  legacyProduction0086: boolean;
};

const fixtures: Fixture[] = [
  { name: "fresh", through: null, legacyProduction0086: false },
  { name: "production", through: 98, legacyProduction0086: true },
  { name: "staging", through: 101, legacyProduction0086: false },
];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const adminUrl = requiredEnv("DATABASE_URL");
const appPassword = requiredEnv("OPENPIMS_APP_DB_PASSWORD");
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const migrationDirectory = join(here, "drizzle");
const journal = JSON.parse(
  readFileSync(join(migrationDirectory, "meta", "_journal.json"), "utf8"),
) as Journal;
const expectedMigrationCount = journal.entries.length;
const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
const databaseNames = fixtures.map(
  (fixture) => `openpims_line_${fixture.name}_${suffix}`,
);
const safeIdentifier = /^[a-z][a-z0-9_]+$/;

for (const databaseName of databaseNames) {
  if (!safeIdentifier.test(databaseName) || databaseName.length > 63) {
    throw new Error("unsafe disposable PostgreSQL identifier");
  }
}

function fixtureUrl(databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function runDatabaseControl(
  databaseUrl: string,
  script: string,
  fixtureName: Fixture["name"],
): void {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    OPENPIMS_APP_DB_PASSWORD: appPassword,
  };
  try {
    execFileSync("pnpm", ["--filter", "@openpims/db", script], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      env,
    });
  } catch {
    throw new Error(
      `${script} failed for the disposable ${fixtureName} fixture`,
    );
  }
}

function runConformance(databaseUrl: string, mode: "prefix" | "exact"): void {
  try {
    execFileSync(
      "pnpm",
      ["--filter", "@openpims/db", "db:migrations:conformance"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          MIGRATION_CONFORMANCE_MODE: mode,
        },
      },
    );
  } catch {
    throw new Error(
      `migration ${mode} conformance failed for a disposable release-line fixture`,
    );
  }
}

async function installCommittedPrefix(
  databaseUrl: string,
  through: number,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql
      .unsafe(
        `
      create schema drizzle;
      create table drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `,
      )
      .simple();

    for (const entry of journal.entries.slice(0, through + 1)) {
      const migrationSql = readFileSync(
        join(migrationDirectory, `${entry.tag}.sql`),
        "utf8",
      );
      await sql.unsafe(migrationSql).simple();
      const hash = createHash("sha256")
        .update(migrationSql, "utf8")
        .digest("hex");
      await sql`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${hash}, ${entry.when})
      `;
    }
  } finally {
    await sql.end();
  }
}

async function markExactLegacyProduction0086(
  databaseUrl: string,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const updated = await sql`
      update drizzle.__drizzle_migrations
      set hash = ${LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY.hash}
      where created_at = ${Number(
        LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY.createdAt,
      )}
      returning id
    `;
    if (updated.length !== 1) {
      throw new Error("legacy Production 0086 fixture identity was not unique");
    }
  } finally {
    await sql.end();
  }
}

async function verifyFinalState(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [state] = await sql<
      Array<{
        migrations: number;
        lifecycleJobs: string | null;
        checkoutAttempts: string | null;
        backupRuns: string | null;
        recoveryCases: string | null;
      }>
    >`
      select
        (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
        to_regclass('public.lifecycle_email_jobs')::text as "lifecycleJobs",
        to_regclass('public.subscription_checkout_attempts')::text as "checkoutAttempts",
        to_regclass('public.backup_runs')::text as "backupRuns",
        to_regclass('public.auth_recovery_cases')::text as "recoveryCases"
    `;
    if (
      state?.migrations !== expectedMigrationCount ||
      state.lifecycleJobs !== "lifecycle_email_jobs" ||
      state.checkoutAttempts !== "subscription_checkout_attempts" ||
      state.backupRuns !== "backup_runs" ||
      state.recoveryCases !== "auth_recovery_cases"
    ) {
      throw new Error(
        "release-line fixture did not reach the exact final schema",
      );
    }
  } finally {
    await sql.end();
  }
}

const admin = postgres(adminUrl, { max: 1 });
let appRoleCreated = false;

try {
  const [appRole] = await admin<{ present: boolean }[]>`
    select exists(select 1 from pg_roles where rolname = 'openpims_app') as present
  `;
  appRoleCreated = !appRole?.present;

  for (const [index, fixture] of fixtures.entries()) {
    const databaseName = databaseNames[index]!;
    await admin.unsafe(`create database "${databaseName}"`);
    const databaseUrl = fixtureUrl(databaseName);

    if (fixture.through !== null) {
      await installCommittedPrefix(databaseUrl, fixture.through);
      if (fixture.legacyProduction0086) {
        await markExactLegacyProduction0086(databaseUrl);
      }
    }

    runConformance(databaseUrl, "prefix");
    runDatabaseControl(databaseUrl, "db:rls:preflight", fixture.name);
    runDatabaseControl(databaseUrl, "db:migrate", fixture.name);
    runDatabaseControl(databaseUrl, "db:rls", fixture.name);
    runDatabaseControl(databaseUrl, "db:drift", fixture.name);
    runConformance(databaseUrl, "exact");
    await verifyFinalState(databaseUrl);

    await admin.unsafe(`drop database "${databaseName}" with (force)`);
  }

  console.log(
    "Release-line reconciliation passed fresh, exact Production, and exact staging migration/RLS/conformance fixtures.",
  );
} finally {
  for (const databaseName of databaseNames) {
    await admin.unsafe(
      `drop database if exists "${databaseName}" with (force)`,
    );
  }
  if (appRoleCreated) {
    await admin.unsafe("drop role if exists openpims_app");
  }
  await admin.end();
}
