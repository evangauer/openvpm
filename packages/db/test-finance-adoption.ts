import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

type SqlClient = ReturnType<typeof postgres>;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function expectRejected(
  label: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

const adminUrl = requiredEnv("DATABASE_URL");
const appPassword = requiredEnv("OPENPIMS_APP_DB_PASSWORD");
const suffix = randomUUID().replaceAll("-", "");
const databaseName = `openpims_finance_adoption_${suffix}`;
const ownerRole = `openpims_finance_owner_${suffix}`;
const ownerPassword = randomUUID();
const safeIdentifier = /^[a-z][a-z0-9_]+$/;

for (const identifier of [databaseName, ownerRole]) {
  if (!safeIdentifier.test(identifier) || identifier.length > 63) {
    throw new Error("unsafe disposable PostgreSQL identifier");
  }
}

const targetAdminUrl = new URL(adminUrl);
targetAdminUrl.pathname = `/${databaseName}`;
targetAdminUrl.search = "";
targetAdminUrl.hash = "";

const targetOwnerUrl = new URL(targetAdminUrl);
targetOwnerUrl.username = ownerRole;
targetOwnerUrl.password = ownerPassword;

const appUrl = new URL(targetAdminUrl);
appUrl.username = "openpims_app";
appUrl.password = appPassword;

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "drizzle");
const repoRoot = resolve(here, "../..");
const admin = postgres(adminUrl, { max: 1 });
let owner: ReturnType<typeof postgres> | undefined;
let targetAdmin: ReturnType<typeof postgres> | undefined;
let app: ReturnType<typeof postgres> | undefined;
let ownerRoleCreated = false;
let databaseCreated = false;

const ids = {
  practiceA: randomUUID(),
  practiceB: randomUUID(),
  clientA: randomUUID(),
  clientB: randomUUID(),
  userA: randomUUID(),
  userB: randomUUID(),
  invoiceA: randomUUID(),
  invoiceB: randomUUID(),
  originalPaymentA: randomUUID(),
  refundPaymentA: randomUUID(),
  originalPaymentB: randomUUID(),
  refundPaymentB: randomUUID(),
  settlementA: randomUUID(),
  settlementB: randomUUID(),
};
const accountA = `acct_a_${suffix}`;
const accountB = `acct_b_${suffix}`;

try {
  await admin.unsafe(
    `create role "${ownerRole}" login password '${ownerPassword}'`,
  );
  ownerRoleCreated = true;
  await admin.unsafe(`create database "${databaseName}" owner "${ownerRole}"`);
  databaseCreated = true;

  owner = postgres(targetOwnerUrl.toString(), { max: 1 });
  const migrationFiles = readdirSync(migrationDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .filter((name) => Number(name.slice(0, 4)) <= 93)
    .sort();

  for (const migrationFile of migrationFiles) {
    await owner
      .unsafe(readFileSync(join(migrationDir, migrationFile), "utf8"))
      .simple();
  }

  await owner`insert into practices (id, name) values
    (${ids.practiceA}, 'Finance adoption A'),
    (${ids.practiceB}, 'Finance adoption B')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id) values
    (${ids.userA}, ${`finance-a-${suffix}@example.com`}, 'test', 'Finance A', 'admin', ${ids.practiceA}),
    (${ids.userB}, ${`finance-b-${suffix}@example.com`}, 'test', 'Finance B', 'admin', ${ids.practiceB})`;
  await owner`insert into clients
    (id, practice_id, first_name, last_name) values
    (${ids.clientA}, ${ids.practiceA}, 'Finance', 'A'),
    (${ids.clientB}, ${ids.practiceB}, 'Finance', 'B')`;
  await owner`insert into practice_payment_accounts
    (practice_id, provider, stripe_account_id, onboarding_status) values
    (${ids.practiceA}, 'stripe_connect', ${accountA}, 'active'),
    (${ids.practiceB}, 'stripe_connect', ${accountB}, 'active')`;
  await owner`insert into invoices
    (id, practice_id, client_id, status, total, paid_amount) values
    (${ids.invoiceA}, ${ids.practiceA}, ${ids.clientA}, 'paid', '100.00', '100.00'),
    (${ids.invoiceB}, ${ids.practiceB}, ${ids.clientB}, 'paid', '100.00', '100.00')`;
  await owner`insert into payments (id, invoice_id, amount, method) values
    (${ids.originalPaymentA}, ${ids.invoiceA}, '100.00', 'online'),
    (${ids.refundPaymentA}, ${ids.invoiceA}, '-10.00', 'online'),
    (${ids.originalPaymentB}, ${ids.invoiceB}, '100.00', 'online'),
    (${ids.refundPaymentB}, ${ids.invoiceB}, '-10.00', 'online')`;
  await owner`insert into payment_processor_settlements
    (id, practice_id, invoice_id, payment_id, provider, connected_account_id,
     checkout_session_id, payment_intent_id, charge_id, balance_transaction_id,
     currency, gross_amount_cents, processor_fee_cents, application_fee_cents,
     clinic_net_cents, balance_status, reconciled_at, last_synced_at) values
    (${ids.settlementA}, ${ids.practiceA}, ${ids.invoiceA}, ${ids.originalPaymentA},
     'stripe_connect', ${accountA}, ${`checkout-a-${suffix}`}, ${`pi-a-${suffix}`},
     ${`charge-a-${suffix}`}, ${`balance-a-${suffix}`}, 'usd', 10000, 300, 200,
     9500, 'available', now(), now()),
    (${ids.settlementB}, ${ids.practiceB}, ${ids.invoiceB}, ${ids.originalPaymentB},
     'stripe_connect', ${accountB}, ${`checkout-b-${suffix}`}, ${`pi-b-${suffix}`},
     ${`charge-b-${suffix}`}, ${`balance-b-${suffix}`}, 'usd', 10000, 300, 200,
     9500, 'available', now(), now())`;

  const before =
    await owner`select count(*)::int as count from payment_processor_settlements`;
  if (before[0]?.count !== 2)
    throw new Error("pre-0094 settlement fixture missing");

  await owner
    .unsafe(
      readFileSync(
        join(migrationDir, "0094_finance_tenant_integrity.sql"),
        "utf8",
      ),
    )
    .simple();

  const after =
    await owner`select count(*)::int as count from payment_processor_settlements`;
  if (after[0]?.count !== 2) {
    throw new Error("0094 did not preserve existing settlement evidence");
  }

  await expectRejected(
    "cross-tenant settlement invoice",
    () =>
      owner!`insert into payment_processor_settlements
      (practice_id, invoice_id, payment_id, provider, connected_account_id,
       checkout_session_id, payment_intent_id, charge_id, balance_transaction_id,
       currency, gross_amount_cents, processor_fee_cents, application_fee_cents,
       clinic_net_cents, balance_status, reconciled_at, last_synced_at) values
      (${ids.practiceA}, ${ids.invoiceB}, ${ids.refundPaymentB}, 'stripe_connect',
       ${accountA}, ${`bad-checkout-${suffix}`}, ${`bad-pi-${suffix}`},
       ${`bad-charge-${suffix}`}, ${`bad-balance-${suffix}`}, 'usd', 1000, 30,
       20, 950, 'pending', now(), now())`,
  );
  await expectRejected(
    "cross-tenant settlement account",
    () =>
      owner!`insert into payment_processor_settlements
      (practice_id, invoice_id, payment_id, provider, connected_account_id,
       checkout_session_id, payment_intent_id, charge_id, balance_transaction_id,
       currency, gross_amount_cents, processor_fee_cents, application_fee_cents,
       clinic_net_cents, balance_status, reconciled_at, last_synced_at) values
      (${ids.practiceA}, ${ids.invoiceA}, ${ids.refundPaymentA}, 'stripe_connect',
       ${accountB}, ${`bad-account-checkout-${suffix}`}, ${`bad-account-pi-${suffix}`},
       ${`bad-account-charge-${suffix}`}, ${`bad-account-balance-${suffix}`},
       'usd', 1000, 30, 20, 950, 'pending', now(), now())`,
  );
  await expectRejected(
    "cross-tenant refund payment",
    () =>
      owner!`insert into payment_processor_refunds
      (practice_id, original_payment_id, refund_payment_id, provider,
       external_refund_id, currency, amount_cents, status, provider_created_at,
       last_synced_at) values
      (${ids.practiceA}, ${ids.originalPaymentA}, ${ids.refundPaymentB},
       'stripe_connect', ${`bad-refund-${suffix}`}, 'usd', 1000, 'succeeded',
       now(), now())`,
  );
  await expectRejected(
    "cross-tenant close actor",
    () =>
      owner!`insert into financial_closes
      (practice_id, business_date, timezone, cutoff_at, closed_by, payment_count,
       gross_receipts_cents, refunds_cents, net_receipts_cents, cash_cents,
       check_cents, card_and_online_cents, other_cents, processor_gross_cents,
       processor_fee_cents, application_fee_cents, clinic_net_cents,
       paid_out_cents, open_dispute_cents, unreconciled_count) values
      (${ids.practiceA}, current_date, 'America/New_York', now(), ${ids.userB},
       0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
  );

  await owner.end();
  owner = undefined;

  execFileSync("pnpm", ["--filter", "@openpims/db", "db:rls"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: targetAdminUrl.toString(),
      OPENPIMS_APP_DB_PASSWORD: appPassword,
    },
    encoding: "utf8",
  });

  targetAdmin = postgres(targetAdminUrl.toString(), { max: 1 });
  const [privileges] = await targetAdmin<
    Array<{
      settlementDelete: boolean;
      closeUpdate: boolean;
      closeDelete: boolean;
      refundFunctionExecute: boolean;
    }>
  >`select
    has_table_privilege('openpims_app', 'payment_processor_settlements', 'delete') as "settlementDelete",
    has_table_privilege('openpims_app', 'financial_closes', 'update') as "closeUpdate",
    has_table_privilege('openpims_app', 'financial_closes', 'delete') as "closeDelete",
    has_function_privilege('openpims_app', 'validate_payment_processor_refund_tenant()', 'execute') as "refundFunctionExecute"`;
  if (
    privileges?.settlementDelete ||
    privileges?.closeUpdate ||
    privileges?.closeDelete ||
    privileges?.refundFunctionExecute
  ) {
    throw new Error(`unsafe finance privileges: ${JSON.stringify(privileges)}`);
  }

  app = postgres(appUrl.toString(), { max: 1 });
  const noContext =
    await app`select count(*)::int as count from payment_processor_settlements`;
  if (noContext[0]?.count !== 0) {
    throw new Error("no-context finance read was not denied by default");
  }

  await app.begin(async (tx) => {
    const scoped = tx as unknown as SqlClient;
    await scoped`select set_config('app.current_practice_id', ${ids.practiceA}, true)`;
    const visible =
      await scoped`select id from payment_processor_settlements order by id`;
    if (visible.length !== 1 || visible[0]?.id !== ids.settlementA) {
      throw new Error("tenant A did not see exactly its own settlement");
    }
    await scoped`insert into payment_disputes
      (practice_id, settlement_id, provider, external_dispute_id, charge_id,
       status, amount_cents, currency, provider_created_at, last_synced_at) values
      (${ids.practiceA}, ${ids.settlementA}, 'stripe_connect',
       ${`dispute-a-${suffix}`}, ${`charge-a-${suffix}`}, 'needs_response', 1000,
       'usd', now(), now())`;
    await scoped`insert into payment_processor_payouts
      (practice_id, provider, connected_account_id, external_payout_id,
       currency, amount_cents, status, automatic, arrival_at,
       provider_created_at, last_synced_at) values
      (${ids.practiceA}, 'stripe_connect', ${accountA}, ${`payout-a-${suffix}`},
       'usd', 9500, 'paid', true, now(), now(), now())`;
    await scoped`insert into payment_processor_refunds
      (practice_id, settlement_id, original_payment_id, refund_payment_id,
       provider, connected_account_id, external_refund_id, currency,
       amount_cents, status, provider_created_at, last_synced_at) values
      (${ids.practiceA}, ${ids.settlementA}, ${ids.originalPaymentA},
       ${ids.refundPaymentA}, 'stripe_connect', ${accountA},
       ${`refund-a-${suffix}`}, 'usd', 1000, 'succeeded', now(), now())`;
    await scoped`insert into financial_closes
      (practice_id, business_date, timezone, cutoff_at, closed_by, payment_count,
       gross_receipts_cents, refunds_cents, net_receipts_cents, cash_cents,
       check_cents, card_and_online_cents, other_cents, processor_gross_cents,
       processor_fee_cents, application_fee_cents, clinic_net_cents,
       paid_out_cents, open_dispute_cents, unreconciled_count) values
      (${ids.practiceA}, current_date, 'America/New_York', now(), ${ids.userA},
       1, 10000, 1000, 9000, 0, 0, 9000, 0, 10000, 300, 200, 9500, 9500,
       1000, 0)`;
  });

  await expectRejected("application cross-tenant settlement write", () =>
    app!.begin(async (tx) => {
      const scoped = tx as unknown as SqlClient;
      await scoped`select set_config('app.current_practice_id', ${ids.practiceA}, true)`;
      await scoped`update payment_processor_settlements set payout_status = 'paid'
        where id = ${ids.settlementB}`;
      const changed = await scoped`select count(*)::int as count
        from payment_processor_settlements
        where id = ${ids.settlementB} and payout_status = 'paid'`;
      if (changed[0]?.count === 0) {
        throw new Error("cross-tenant row remained invisible");
      }
    }),
  );
  await expectRejected(
    "direct refund validator execution",
    () => app!`select validate_payment_processor_refund_tenant()`,
  );

  console.log(
    "Finance adoption PostgreSQL contract passed: 0093 evidence preserved; tenant constraints, RLS, trigger, and immutable-close privileges enforced.",
  );
} finally {
  if (app) await app.end();
  if (owner) await owner.end();
  if (targetAdmin) await targetAdmin.end();
  if (databaseCreated) {
    await admin.unsafe(`drop database "${databaseName}" with (force)`);
  }
  if (ownerRoleCreated) {
    await admin.unsafe(`drop role "${ownerRole}"`);
  }
  await admin.end();
}
