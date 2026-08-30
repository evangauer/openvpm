import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "./client";
import { resetDatabase } from "./reset";

function assertDisposableCiTarget(): void {
  if (process.env.RESET_DB_INTEGRATION !== "1" || process.env.CI !== "true") {
    throw new Error("Reset integration contract is CI-only.");
  }
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required.");
  const url = new URL(value);
  if (
    !new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
    !new Set(["localhost", "127.0.0.1", "::1"]).has(
      url.hostname.toLowerCase(),
    ) ||
    decodeURIComponent(url.pathname.slice(1)) !== "openpims"
  ) {
    throw new Error(
      "Reset integration contract requires disposable CI Postgres.",
    );
  }
}

async function main(): Promise<number> {
  try {
    assertDisposableCiTarget();
    await db.execute(sql`
      insert into practices (name, subscription_tier)
      values ('Reset contract sentinel', 'cloud')
    `);
    const tablesReset = await resetDatabase();
    const [remaining] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from practices
    `);
    const [migrationLedger] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `);
    if (
      tablesReset < 1 ||
      remaining?.count !== 0 ||
      !migrationLedger ||
      migrationLedger.count < 1
    ) {
      throw new Error(
        "Reset did not clear application data and retain history.",
      );
    }
    console.log(
      JSON.stringify({
        status: "passed",
        tablesReset,
        applicationRowsRemaining: remaining.count,
        migrationHistoryRetained: true,
      }),
    );
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Reset integration failed.",
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
