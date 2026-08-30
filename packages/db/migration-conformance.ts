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

export const CANONICAL_0086_MIGRATION_IDENTITY: MigrationIdentity = {
  hash: "8dce4cb82cec1aa8355242d34d0b703873e5b1f5967cb0d86295172c086b4590",
  createdAt: "1786491884265",
};

export const LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY: MigrationIdentity = {
  hash: "719ba65a004fa30054e1fafc540a9aa5a2cae570376728ca06ae8db34f6aa131",
  createdAt: "1786491884265",
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
  legacy0086AdoptionProven?: boolean;
}): string[] {
  const { expected, applied, mode, legacy0086AdoptionProven = false } = input;
  const issues: string[] = [];
  if (applied.length > expected.length) {
    issues.push("Database migration history is ahead of committed history");
  }

  const comparable = Math.min(applied.length, expected.length);
  for (let index = 0; index < comparable; index += 1) {
    const wanted = expected[index]!;
    const found = applied[index]!;
    if (wanted.createdAt !== found.createdAt || wanted.hash !== found.hash) {
      const exactLegacyProduction0086 =
        index === 86 &&
        wanted.createdAt === CANONICAL_0086_MIGRATION_IDENTITY.createdAt &&
        wanted.hash === CANONICAL_0086_MIGRATION_IDENTITY.hash &&
        found.createdAt ===
          LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY.createdAt &&
        found.hash === LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY.hash;
      if (exactLegacyProduction0086) {
        if (!legacy0086AdoptionProven) {
          issues.push("Legacy 0086 tenant-context adoption is not proven");
          break;
        }
        continue;
      }
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

function usesLegacyProduction0086(applied: MigrationIdentity[]): boolean {
  const migration = applied[86];
  return (
    migration?.createdAt ===
      LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY.createdAt &&
    migration.hash === LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY.hash
  );
}

async function legacy0086AdoptionIsProven(sql: SqlClient): Promise<boolean> {
  const [row] = await sql<{ proven: boolean }[]>`
    select coalesce(
      pg_catalog.pg_get_function_result(proc.oid) = 'uuid'
      and proc.provolatile = 's'
      and not proc.prosecdef
      and proc.proconfig @> array['search_path=""']::text[]
      and position(
        'current_setting(''app.current_practice_id'', true)'
        in pg_catalog.pg_get_functiondef(proc.oid)
      ) > 0
      and position(
        'nullif('
        in pg_catalog.pg_get_functiondef(proc.oid)
      ) > 0,
      false
    ) as proven
    from (select pg_catalog.to_regprocedure(
      'public.app_current_practice_id()'
    ) as oid) target
    left join pg_catalog.pg_proc proc on proc.oid = target.oid
  `;
  return row?.proven === true;
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
    const legacy0086AdoptionProven = usesLegacyProduction0086(applied)
      ? await legacy0086AdoptionIsProven(sql)
      : false;
    const issues = migrationConformanceIssues({
      expected,
      applied,
      mode,
      legacy0086AdoptionProven,
    });
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
