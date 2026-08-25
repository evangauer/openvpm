import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import postgres from "postgres";
import { isPooledDatabaseConnection } from "./connection-policy";

export type MigrationIdentity = {
  hash: string;
  createdAt: string;
};

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; when: number; tag: string }>;
};

export type MigrationConformanceMode = "prefix" | "exact";

export function expectedMigrationIdentities(
  migrationsDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    "drizzle",
  ),
): MigrationIdentity[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsDirectory, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  if (journal.version !== "7" || journal.dialect !== "postgresql") {
    throw new Error("Committed migration journal format is unsupported");
  }

  return journal.entries.map((entry, position) => {
    if (entry.idx !== position || !Number.isSafeInteger(entry.when)) {
      throw new Error("Committed migration journal ordering is invalid");
    }
    const sql = readFileSync(
      join(migrationsDirectory, `${entry.tag}.sql`),
      "utf8",
    );
    return {
      hash: createHash("sha256").update(sql, "utf8").digest("hex"),
      createdAt: String(entry.when),
    };
  });
}

export function migrationConformanceIssues(input: {
  expected: MigrationIdentity[];
  applied: MigrationIdentity[];
  mode: MigrationConformanceMode;
}): string[] {
  const { expected, applied, mode } = input;
  const issues: string[] = [];
  if (applied.length > expected.length) {
    issues.push("Database migration history is ahead of committed history");
  }

  const comparable = Math.min(applied.length, expected.length);
  for (let index = 0; index < comparable; index += 1) {
    const wanted = expected[index]!;
    const found = applied[index]!;
    if (wanted.createdAt !== found.createdAt || wanted.hash !== found.hash) {
      issues.push(`Database migration history diverges at position ${index}`);
      break;
    }
  }

  if (mode === "exact" && applied.length < expected.length) {
    issues.push("Database migration history is behind committed history");
  }
  return issues;
}

type SqlClient = ReturnType<typeof postgres>;

export async function appliedMigrationIdentities(
  sql: SqlClient,
): Promise<MigrationIdentity[]> {
  const [state] = await sql<{ present: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present
  `;
  if (!state?.present) return [];

  const rows = await sql<{ hash: string; createdAt: string }[]>`
    select hash, created_at::text as "createdAt"
    from drizzle.__drizzle_migrations
    order by created_at asc, id asc
  `;
  return rows.map((row) => ({ hash: row.hash, createdAt: row.createdAt }));
}

function conformanceMode(value: string | undefined): MigrationConformanceMode {
  if (value === "prefix" || value === "exact") return value;
  throw new Error("MIGRATION_CONFORMANCE_MODE must be prefix or exact");
}

async function main(): Promise<number> {
  config({ path: "../../.env" });
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("Migration conformance failed: DATABASE_URL is not set");
    return 1;
  }

  let mode: MigrationConformanceMode;
  try {
    mode = conformanceMode(process.env.MIGRATION_CONFORMANCE_MODE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }

  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: !isPooledDatabaseConnection(databaseUrl),
  });
  try {
    const expected = expectedMigrationIdentities();
    const applied = await appliedMigrationIdentities(sql);
    const issues = migrationConformanceIssues({ expected, applied, mode });
    if (issues.length > 0) {
      for (const issue of issues) console.error(issue);
      return 1;
    }
    console.log(
      `Migration history ${mode} conformance passed (${applied.length} applied).`,
    );
    return 0;
  } catch (error) {
    console.error(
      "Migration conformance failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
