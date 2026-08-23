import { config } from "dotenv";
config({ path: "../../.env" });

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import postgres from "postgres";
import { assertRlsDeploymentCapability } from "./rls-preflight";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const url = nonBlankEnv("DATABASE_URL");
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sqlText = readFileSync(join(here, "rls", "enable-rls.sql"), "utf8");

const sql = postgres(url, { max: 1 });
try {
  // Fail before role/password, grant, function, policy, or table mutations when
  // the deployment credential cannot manage every object touched below.
  await assertRlsDeploymentCapability(sql);

  // Ensure the least-privilege app role exists BEFORE the grants run. No
  // credential is committed: the password comes from OPENPIMS_APP_DB_PASSWORD.
  const [exists] =
    await sql`select 1 from pg_roles where rolname = 'openpims_app'`;
  const appPw = nonBlankEnv("OPENPIMS_APP_DB_PASSWORD");
  if (!exists) {
    if (!appPw) {
      console.error(
        "openpims_app role does not exist. Create it with a strong password, " +
          "or set OPENPIMS_APP_DB_PASSWORD and re-run `pnpm db:rls`.",
      );
      process.exit(1);
    }
    const q = appPw.replace(/'/g, "''"); // escape single quotes
    await sql.unsafe(`CREATE ROLE openpims_app LOGIN PASSWORD '${q}'`);
    console.log("✓ created openpims_app role");
  } else if (appPw) {
    const q = appPw.replace(/'/g, "''");
    await sql.unsafe(`ALTER ROLE openpims_app PASSWORD '${q}'`);
    console.log("✓ rotated openpims_app password");
  }

  // Simple protocol so the multi-statement / DO-block migration runs as one.
  await sql.unsafe(sqlText).simple();
  console.log("✓ RLS policies applied (run as the DB owner).");
} catch (err) {
  console.error(
    "✗ Failed to apply RLS policies:",
    err instanceof Error ? err.message : err,
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
