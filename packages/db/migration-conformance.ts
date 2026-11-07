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

// Supabase/PostGIS can own this reference table in public before application
// migrations run. No other public table is accepted without a Drizzle ledger.
export type PublicTableIdentity = {
  name: string;
  extension: string | null;
};

export const PROVIDER_OWNED_PUBLIC_TABLE_ALLOWLIST: readonly PublicTableIdentity[] =
  [{ name: "spatial_ref_sys", extension: "postgis" }];

export function unexpectedPublicApplicationTables(
  tables: readonly PublicTableIdentity[],
): string[] {
  return tables
    .filter(
      (table) =>
        !PROVIDER_OWNED_PUBLIC_TABLE_ALLOWLIST.some(
          (allowed) =>
            allowed.name === table.name &&
            allowed.extension === table.extension,
        ),
    )
    .map((table) => table.name)
    .sort();
}

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

export async function assertEmptyMigrationBaseline(
  sql: SqlClient,
): Promise<void> {
  const rows = await sql<PublicTableIdentity[]>`
    select c.relname as name, e.extname as extension
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_depend d
      on d.classid = 'pg_class'::regclass
      and d.objid = c.oid
      and d.refclassid = 'pg_extension'::regclass
      and d.deptype = 'e'
    left join pg_extension e on e.oid = d.refobjid
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'f')
    order by c.relname
  `;
  const unexpected = unexpectedPublicApplicationTables(rows);
  if (unexpected.length > 0) {
    throw new Error(
      `Database has ${unexpected.length} public application table(s) without migration history`,
    );
  }
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
  } catch {
    console.error(
      "Migration conformance failed: mode must be prefix or exact.",
    );
    return 1;
  }

  let sql: SqlClient | undefined;
  try {
    sql = postgres(databaseUrl, {
      max: 1,
      prepare: !isPooledDatabaseConnection(databaseUrl),
    });
    const expected = expectedMigrationIdentities();
    const applied = await appliedMigrationIdentities(sql);
    if (applied.length === 0) await assertEmptyMigrationBaseline(sql);
    const issues = migrationConformanceIssues({ expected, applied, mode });
    if (issues.length > 0) {
      for (const issue of issues) console.error(issue);
      return 1;
    }
    console.log(
      `Migration history ${mode} conformance passed (${applied.length} applied).`,
    );
    return 0;
  } catch {
    console.error(
      "Migration conformance failed: database state could not be safely validated.",
    );
    return 1;
  } finally {
    if (sql) {
      try {
        await sql.end();
      } catch {
        // Connection teardown details can contain the target hostname.
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
