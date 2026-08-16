/**
 * Fail-closed migration integrity check.
 *
 * Static mode verifies journal order, SQL presence, snapshot lineage, and
 * computes the exact hashes Drizzle records. `--live` additionally performs
 * read-only comparison against drizzle.__drizzle_migrations after migrate.
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { isPooledDatabaseConnection } from "./connection-policy";
import {
  loadExpectedMigrations,
  validateAppliedLedger,
  validateAppliedLedgerPrefix,
  type AppliedMigration,
} from "./migration-integrity";

const here = dirname(fileURLToPath(import.meta.url));
const { expected, errors: staticErrors } = loadExpectedMigrations(
  join(here, "drizzle"),
);

function fail(errors: string[]): never {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

if (staticErrors.length > 0) {
  console.error("Migration artifact integrity failed:");
  fail(staticErrors);
}
console.log(
  `OK — ${expected.length} committed migrations are ordered and linked.`,
);

const verifyExactLive = process.argv.includes("--live");
const verifyLivePrefix = process.argv.includes("--live-prefix");
if (!verifyExactLive && !verifyLivePrefix) process.exit(0);

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required for --live verification.");
  process.exit(1);
}

function safeTarget(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

const client = postgres(url, {
  max: 1,
  prepare: !isPooledDatabaseConnection(url),
});

try {
  const table = await client<{ present: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present
  `;
  if (!table[0]?.present) {
    fail(["The live Drizzle migration ledger does not exist."]);
  }

  const rows = await client<{ hash: string; created_at: string }[]>`
    select hash, created_at::text
    from drizzle.__drizzle_migrations
    order by created_at asc, id asc
  `;
  const applied: AppliedMigration[] = rows.map((row) => ({
    hash: row.hash,
    createdAt: Number(row.created_at),
  }));
  const liveErrors = verifyLivePrefix
    ? validateAppliedLedgerPrefix(expected, applied)
    : validateAppliedLedger(expected, applied);
  if (liveErrors.length > 0) {
    console.error(`Migration ledger integrity failed for ${safeTarget(url)}:`);
    fail(liveErrors);
  }
  console.log(
    verifyLivePrefix
      ? `OK — live ledger at ${safeTarget(url)} is an exact committed prefix.`
      : `OK — live ledger at ${safeTarget(url)} exactly matches committed order and hashes.`,
  );
} finally {
  await client.end();
}
