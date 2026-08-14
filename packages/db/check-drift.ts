/**
 * Schema drift check. Connects to DATABASE_URL and reports any table or column
 * the deployed code expects but the database does not have.
 *
 * Run with: pnpm db:drift
 *
 * Point DATABASE_URL at any environment to audit it before or after a deploy:
 *   DATABASE_URL='postgres://…demo…' pnpm db:drift
 *
 * Exits non-zero on drift so it can gate a deploy or run from cron.
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { findSchemaDrift, driftIsClean } from "./schema-drift";
import { isPooledDatabaseConnection } from "./connection-policy";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

// Supabase's transaction pooler rejects the prepared statements postgres-js
// uses by default; mirror the app client's handling so this works everywhere.
const pooled = isPooledDatabaseConnection(url);

const client = postgres(url, { max: 1, prepare: !pooled });
const db = drizzle(client);

// Show which database was inspected without ever printing the password.
function safeTarget(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  console.log(`Checking schema drift against ${safeTarget(url!)}`);
  const drift = await findSchemaDrift(db);

  if (driftIsClean(drift)) {
    console.log("OK — database schema matches the deployed code.");
    return 0;
  }

  console.error("\nDRIFT DETECTED — the database is behind the code.\n");

  if (drift.missingTables.length > 0) {
    console.error(`Missing tables (${drift.missingTables.length}):`);
    for (const table of drift.missingTables) console.error(`  - ${table}`);
    console.error("");
  }

  if (drift.missingColumns.length > 0) {
    console.error(`Missing columns (${drift.missingColumns.length}):`);
    for (const { table, column } of drift.missingColumns) {
      console.error(`  - ${table}.${column}`);
    }
    console.error("");
  }

  if (drift.invalidObjects.length > 0) {
    console.error(
      `Critical database controls missing or invalid (${drift.invalidObjects.length}):`,
    );
    for (const { kind, table, name } of drift.invalidObjects) {
      console.error(`  - ${kind}: ${table}.${name}`);
    }
    console.error("");
  }

  console.error(
    "Apply the outstanding migrations and RLS policy, then validate staged constraints before deploying the application.",
  );
  return 1;
}

main()
  .then(async (code) => {
    await client.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(
      "Drift check failed:",
      err instanceof Error ? err.message : err,
    );
    await client.end();
    process.exit(1);
  });
