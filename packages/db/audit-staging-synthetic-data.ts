import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "./client";
import { assertStagingResetPolicy } from "./reset-policy";

const SHA_PATTERN = /^[0-9a-f]{40}$/;

type ContactColumn = {
  table_name: string;
  column_name: string;
  contact_kind: "email" | "phone";
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function unsafeContactCount(column: ContactColumn): Promise<number> {
  const table = `${quoteIdentifier("public")}.${quoteIdentifier(column.table_name)}`;
  const field = quoteIdentifier(column.column_name);
  const safeExpression =
    column.contact_kind === "email"
      ? `lower(${field}::text) ~ '@([a-z0-9-]+\\.)*(example\\.(com|net|org)|invalid)$'`
      : `regexp_replace(${field}::text, '[^0-9]', '', 'g') ~ '^(1)?555[0-9]*$'`;
  const rows = await db.execute<{ unsafe_count: number }>(
    sql.raw(`select count(*)::int as unsafe_count from ${table}
      where ${field} is not null
        and btrim(${field}::text) <> ''
        and not (${safeExpression})`),
  );
  return rows[0]?.unsafe_count ?? 0;
}

async function main(): Promise<number> {
  try {
    const target = assertStagingResetPolicy(process.env);
    const releaseSha = required("STAGING_RELEASE_SHA").toLowerCase();
    if (!SHA_PATTERN.test(releaseSha)) {
      throw new Error("STAGING_RELEASE_SHA must be an exact commit SHA.");
    }

    const [counts] = await db.execute<{
      practices: number;
      locations: number;
      users: number;
      clients: number;
      patients: number;
      known_seed_practices: number;
    }>(sql`
      select
        (select count(*)::int from practices) as practices,
        (select count(*)::int from locations) as locations,
        (select count(*)::int from users) as users,
        (select count(*)::int from clients) as clients,
        (select count(*)::int from patients) as patients,
        (select count(*)::int from practices
          where email = 'hello@neighborhoodvet.example.com'
            and name = 'Neighborhood Veterinary') as known_seed_practices
    `);
    if (!counts) throw new Error("Staging fixture counts are unavailable.");

    const contactColumns = await db.execute<ContactColumn>(sql`
      select table_name, column_name,
        case
          when column_name ~ '(^|_)email$' then 'email'
          else 'phone'
        end as contact_kind
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('character varying', 'text')
        and (
          column_name ~ '(^|_)email$'
          or column_name ~ '(phone|e164)$'
        )
      order by table_name, column_name
    `);
    const findings: Array<{
      table: string;
      column: string;
      kind: "email" | "phone";
      unsafeRows: number;
    }> = [];
    for (const column of contactColumns) {
      const unsafeRows = await unsafeContactCount(column);
      if (unsafeRows > 0) {
        findings.push({
          table: column.table_name,
          column: column.column_name,
          kind: column.contact_kind,
          unsafeRows,
        });
      }
    }

    const expectedCounts = {
      practices: 1,
      locations: 1,
      users: 8,
      clients: 25,
      patients: 40,
      known_seed_practices: 1,
    };
    const fixtureMatches = Object.entries(expectedCounts).every(
      ([name, count]) => counts[name as keyof typeof counts] === count,
    );
    const releaseSafe = fixtureMatches && findings.length === 0;
    const evidence = {
      evidenceFormatVersion: 1,
      releaseSha,
      checkedAt: new Date().toISOString(),
      databaseTargetFingerprint: target.projectRefFingerprint,
      resetSource: "repository-seed",
      fixtureCounts: counts,
      inspectedContactColumns: contactColumns.length,
      findings,
      syntheticOnly: releaseSafe,
      realContactDestinationsFree: findings.length === 0,
      releaseSafe,
    };
    const outputPath = process.env.STAGING_SYNTHETIC_EVIDENCE_PATH?.trim();
    if (outputPath) writeFileSync(outputPath, `${JSON.stringify(evidence)}\n`);
    console.log(JSON.stringify(evidence));
    if (!releaseSafe) throw new Error("Staging synthetic-data audit failed.");
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Staging data audit failed.",
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
