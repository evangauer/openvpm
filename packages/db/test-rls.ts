/**
 * Live Row-Level Security verification. Connects as the least-privilege
 * `openpims_app` role and proves tenant isolation against a real database.
 *
 * Run with: pnpm db:rls:test   (requires the DB up + pnpm db:rls applied)
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import postgres from "postgres";
import { randomUUID } from "crypto";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function appRoleUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = "openpims_app";
  url.password = nonBlankEnv("OPENPIMS_APP_DB_PASSWORD") ?? "openpims_app";
  return url.toString();
}

const ownerUrl = nonBlankEnv("DATABASE_URL");
if (!ownerUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
// Derive the restricted-role URL by swapping in the app-role credentials.
const appUrl = appRoleUrl(ownerUrl);

const owner = postgres(ownerUrl, { max: 1 });
const app = postgres(appUrl, { max: 1 });

const aId = randomUUID();
const bId = randomUUID();
const aInvoice = randomUUID();
const bInvoice = randomUUID();
const funnelEventId = randomUUID();
let failures = 0;

async function appTransaction<T>(
  fn: (tx: typeof app) => Promise<T>,
): Promise<T> {
  return app.begin((tx) => fn(tx as unknown as typeof app)) as Promise<T>;
}

function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures++;
}

try {
  // Arrange (as owner — bypasses RLS).
  await owner`insert into practices (id, name) values (${aId}, 'RLS Test A'), (${bId}, 'RLS Test B')`;
  await owner`insert into clients (practice_id, first_name, last_name) values
    (${aId}, 'Alice', 'A'), (${bId}, 'Bob', 'B')`;
  await owner`insert into funnel_events (id, event_name, practice_id)
    values (${funnelEventId}, 'registration', ${aId})`;

  // Tenant A context sees only A's rows.
  const aRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select practice_id from clients where practice_id in (${aId}, ${bId})`;
  });
  check("tenant A sees only A's clients", aRows.length === 1 && aRows[0]!.practice_id === aId);

  // Tenant B context sees only B's rows.
  const bRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${bId}, true)`;
    return tx`select practice_id from clients where practice_id in (${aId}, ${bId})`;
  });
  check("tenant B sees only B's clients", bRows.length === 1 && bRows[0]!.practice_id === bId);

  // Child tables without practice_id isolate via the parent join policy.
  // invoice_adjustments is the representative (regression: it was missing
  // from enable-rls.sql entirely, leaving it readable across tenants).
  await owner`insert into invoices (id, practice_id, client_id, subtotal, tax, total)
    select i.id, i.practice_id, c.id, 0, 0, 0
    from (values (${aInvoice}::uuid, ${aId}::uuid), (${bInvoice}::uuid, ${bId}::uuid)) as i(id, practice_id)
    join clients c on c.practice_id = i.practice_id`;
  await owner`insert into invoice_adjustments (invoice_id, type, amount) values
    (${aInvoice}, 'credit', 1), (${bInvoice}, 'credit', 2)`;
  const aAdj = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select invoice_id from invoice_adjustments where invoice_id in (${aInvoice}, ${bInvoice})`;
  });
  check(
    "tenant A sees only A's invoice adjustments (child join policy)",
    aAdj.length === 1 && aAdj[0]!.invoice_id === aInvoice,
  );

  // Cross-tenant WRITE is rejected by the WITH CHECK clause.
  let writeBlocked = false;
  try {
    await appTransaction(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${aId}, true)`;
      await tx`insert into clients (practice_id, first_name, last_name) values (${bId}, 'Evil', 'X')`;
    });
  } catch {
    writeBlocked = true;
  }
  check("cross-tenant INSERT is blocked", writeBlocked);

  // No tenant context → deny by default.
  const noneRows = await app`select practice_id from clients where practice_id in (${aId}, ${bId})`;
  check("no tenant context → zero rows", noneRows.length === 0);

  // Product analytics is system-only even with a valid tenant context. The
  // public ingestion route writes under an explicit system transaction.
  const hiddenFunnelRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.current_practice_id', ${aId}, true)`;
    return tx`select id from funnel_events where id = ${funnelEventId}`;
  });
  check(
    "tenant context cannot read system-only funnel events",
    hiddenFunnelRows.length === 0,
  );

  // System bypass sees both (for cron / platform admin).
  const allRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select practice_id from clients where practice_id in (${aId}, ${bId})`;
  });
  check("system bypass sees both practices", allRows.length === 2);
  const systemFunnelRows = await appTransaction(async (tx) => {
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return tx`select id from funnel_events where id = ${funnelEventId}`;
  });
  check(
    "system bypass can read funnel events",
    systemFunnelRows.length === 1,
  );
} catch (err) {
  console.error("Unexpected error:", err);
  failures++;
} finally {
  // Cleanup (as owner).
  await owner`delete from invoice_adjustments where invoice_id in (${aInvoice}, ${bInvoice})`;
  await owner`delete from funnel_events where id = ${funnelEventId}`;
  await owner`delete from invoices where id in (${aInvoice}, ${bInvoice})`;
  await owner`delete from clients where practice_id in (${aId}, ${bId})`;
  await owner`delete from practices where id in (${aId}, ${bId})`;
  await owner.end();
  await app.end();
}

if (failures > 0) {
  console.error(`\n✗ ${failures} RLS check(s) FAILED`);
  process.exit(1);
}
console.log("\n✓ All RLS isolation checks passed.");
