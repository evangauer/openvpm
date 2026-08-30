import { config } from "dotenv";
config({ path: "../../.env" });
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "./client";
import { assertLocalResetPolicy } from "./reset-policy";
import { declaredSchema } from "./schema-drift";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Clear every application table declared by the current Drizzle schema,
 * including tables added after this helper was written. Extension-managed
 * public tables and the migration ledger remain intact. Callers must enforce a
 * reset policy before invoking this function.
 */
export async function resetDatabase(): Promise<number> {
  const tableNames = [...declaredSchema().keys()].sort();
  if (tableNames.length === 0) {
    throw new Error(
      "Reset refused because the application schema has no tables.",
    );
  }
  const tableList = tableNames
    .map((name) => `${quoteIdentifier("public")}.${quoteIdentifier(name)}`)
    .join(", ");
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`),
  );
  return tableNames.length;
}

async function main(): Promise<number> {
  try {
    assertLocalResetPolicy(process.env);
    const count = await resetDatabase();
    console.log(`Reset ${count} local public tables.`);
    return 0;
  } catch (error) {
    console.error(
      "Reset refused:",
      error instanceof Error ? error.message : "invalid reset request",
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
