/**
 * One-time migration baseline.
 *
 * Environments built with `drizzle-kit push` have no migration ledger, so
 * `drizzle-kit migrate` would try to replay every migration from 0000 against a
 * database that already has the schema. Without a ledger there is also no way
 * to ask a database what it has applied, which is how a deploy shipped ahead of
 * production and stayed broken until a customer noticed.
 *
 * This writes the ledger drizzle-kit expects and marks migrations as already
 * applied, so `pnpm db:migrate` becomes the normal way to move any environment
 * forward from here on.
 *
 * Usage:
 *   pnpm db:baseline --through 0030            # dry run, prints the plan
 *   pnpm db:baseline --through 0030 --apply    # write the ledger
 *
 * Pick --through by checking what the database actually has first:
 *   pnpm db:drift
 *
 * Anything after --through is left for `pnpm db:migrate` to apply normally.
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";
import { isPooledDatabaseConnection } from "./connection-policy";
import { describeDrift, driftIsClean, type SchemaDrift } from "./schema-drift";

type JournalEntry = { idx: number; tag: string; when: number };
type SnapshotTable = {
  name: string;
  schema: string;
  columns: Record<string, { name: string }>;
};
type MigrationSnapshot = { tables: Record<string, SnapshotTable> };

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const throughArg = args[args.indexOf("--through") + 1];

if (!args.includes("--through") || !throughArg || throughArg.startsWith("--")) {
  console.error(
    "Usage: pnpm db:baseline --through <migration-prefix> [--apply]\n" +
      "Example: pnpm db:baseline --through 0030 --apply",
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const journalPath = join(here, "drizzle", "meta", "_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
  entries: JournalEntry[];
};

const cutoff = journal.entries.findIndex((e) => e.tag.startsWith(throughArg));
if (cutoff === -1) {
  console.error(
    `No migration in the journal starts with "${throughArg}".\n` +
      `Known tags: ${journal.entries.map((e) => e.tag).join(", ")}`,
  );
  process.exit(1);
}

const toMark = journal.entries.slice(0, cutoff + 1);
const remaining = journal.entries.slice(cutoff + 1);

function snapshotPath(entry: JournalEntry): string {
  const prefix = entry.tag.split("_", 1)[0];
  return join(here, "drizzle", "meta", `${prefix}_snapshot.json`);
}

/** Verify the live database contains every table/column at the chosen cutoff. */
async function findBaselineDrift(entry: JournalEntry): Promise<SchemaDrift> {
  const snapshot = JSON.parse(
    readFileSync(snapshotPath(entry), "utf8"),
  ) as MigrationSnapshot;
  const expected = new Map<string, Set<string>>();

  for (const table of Object.values(snapshot.tables)) {
    if (table.schema && table.schema !== "public") continue;
    expected.set(
      table.name,
      new Set(Object.values(table.columns).map((column) => column.name)),
    );
  }

  const rows = await client<
    { table_name: string; column_name: string }[]
  >`select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'`;
  const live = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = live.get(row.table_name);
    if (columns) columns.add(row.column_name);
    else live.set(row.table_name, new Set([row.column_name]));
  }

  const missingTables: string[] = [];
  const missingColumns: SchemaDrift["missingColumns"] = [];
  for (const [table, columns] of expected) {
    const liveColumns = live.get(table);
    if (!liveColumns) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) {
      if (!liveColumns.has(column)) missingColumns.push({ table, column });
    }
  }

  missingTables.sort();
  missingColumns.sort((a, b) =>
    a.table === b.table
      ? a.column.localeCompare(b.column)
      : a.table.localeCompare(b.table),
  );
  // Baseline adoption predates application-managed constraints and policies;
  // the full post-migration contract is enforced by `db:drift`.
  return { missingTables, missingColumns, invalidObjects: [] };
}

// drizzle-kit identifies an applied migration by the SHA-256 of the migration
// file's contents, so the ledger has to be written with the same hash it will
// compute on the next `migrate` run.
function migrationHash(tag: string): string {
  const sql = readFileSync(join(here, "drizzle", `${tag}.sql`), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

const pooled = isPooledDatabaseConnection(url);
const client = postgres(url, { max: 1, prepare: !pooled });

function safeTarget(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  console.log(`Target: ${safeTarget(url!)}`);

  const existing = await client`
    select count(*)::int as n
    from information_schema.tables
    where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
  `;
  const ledgerExists = existing[0]?.n > 0;

  if (ledgerExists) {
    const applied = await client`
      select count(*)::int as n from drizzle."__drizzle_migrations"
    `;
    console.log(
      `A migration ledger already exists with ${applied[0]?.n ?? 0} row(s).`,
    );
    console.log(
      "Baselining is a one-time operation — use `pnpm db:migrate` instead.",
    );
    return 1;
  }

  const target = toMark[toMark.length - 1]!;
  const drift = await findBaselineDrift(target);
  if (!driftIsClean(drift)) {
    console.error(
      `Cannot baseline through ${target.tag}: the live database does not match that migration snapshot.`,
    );
    console.error(describeDrift(drift));
    console.error(
      "Apply or push the missing schema changes, then run the baseline again.",
    );
    return 1;
  }

  console.log(`\nWill mark ${toMark.length} migration(s) as already applied:`);
  for (const entry of toMark) console.log(`  ✓ ${entry.tag}`);

  if (remaining.length > 0) {
    console.log(
      `\nWill leave ${remaining.length} migration(s) for \`pnpm db:migrate\`:`,
    );
    for (const entry of remaining) console.log(`  → ${entry.tag}`);
  } else {
    console.log(
      "\nNo migrations left over — the selected snapshot is current.",
    );
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write the ledger.");
    return 0;
  }

  await client.begin(async (tx) => {
    await tx.unsafe("create schema if not exists drizzle");
    await tx.unsafe(`
      create table if not exists drizzle."__drizzle_migrations" (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);
    for (const entry of toMark) {
      await tx.unsafe(
        `insert into drizzle."__drizzle_migrations" (hash, created_at)
         values ($1, $2)`,
        [migrationHash(entry.tag), entry.when],
      );
    }
  });

  console.log(`\nBaseline written. ${toMark.length} migration(s) recorded.`);
  console.log("Run `pnpm db:migrate` to apply anything outstanding.");
  return 0;
}

main()
  .then(async (code) => {
    await client.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("Baseline failed:", err instanceof Error ? err.message : err);
    await client.end();
    process.exit(1);
  });
