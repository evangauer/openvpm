import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as schema from "../../../../../packages/db/schema/index";
import { withTenant } from "@/lib/tenant-db";
import {
  closeFinancialDay,
  loadFinancialDayStatement,
} from "../financial-close";

const repoRoot = resolve(process.cwd(), "../..");
const describeWithPostgres =
  process.env.FINANCIAL_CLOSE_DB_INTEGRATION === "1"
    ? describe.sequential
    : describe.skip;

function runDatabaseSetup(databaseUrl: string, appPassword: string): void {
  execFileSync("pnpm", ["--filter", "@openpims/db", "db:migrate"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: 60_000,
  });
  execFileSync("pnpm", ["--filter", "@openpims/db", "db:rls"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      OPENPIMS_APP_DB_PASSWORD: appPassword,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 8_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitUntilBlocked(
  observer: ReturnType<typeof postgres>,
  pid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] =
      await observer`select cardinality(pg_blocking_pids(${pid}))::int as blockers`;
    if (Number(row?.blockers ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`payment writer ${pid} never reached the practice lock`);
}

async function expectConstraint(
  operation: Promise<unknown>,
  constraintName: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5; depth += 1) {
      if (typeof current !== "object" || current === null) break;
      if ("code" in current) break;
      current = "cause" in current ? current.cause : null;
    }
    expect(current).toMatchObject({
      code: "23514",
      constraint_name: constraintName,
    });
    return;
  }
  throw new Error(`${constraintName} unexpectedly allowed the write`);
}

describeWithPostgres(
  "immutable clinic-day financial close PostgreSQL contract",
  () => {
    it("proves timezone boundaries, blockers, immutability, and writer serialization", async () => {
      const adminUrl = process.env.DATABASE_URL?.trim();
      if (!adminUrl) throw new Error("DATABASE_URL is required");
      const parsedAdminUrl = new URL(adminUrl);
      if (
        !["localhost", "127.0.0.1", "::1"].includes(parsedAdminUrl.hostname)
      ) {
        throw new Error(
          "This drill is restricted to disposable local PostgreSQL",
        );
      }

      const suffix = randomUUID().replaceAll("-", "");
      const databaseName = `openvpm_financial_close_${suffix}`;
      if (!/^openvpm_financial_close_[a-f0-9]+$/.test(databaseName)) {
        throw new Error("unsafe disposable database name");
      }
      const databaseUrl = new URL(adminUrl);
      databaseUrl.pathname = `/${databaseName}`;
      databaseUrl.search = "";
      databaseUrl.hash = "";
      const appPassword = process.env.OPENPIMS_APP_DB_PASSWORD?.trim();
      if (!appPassword) {
        throw new Error("OPENPIMS_APP_DB_PASSWORD is required");
      }
      const appUrl = new URL(databaseUrl);
      appUrl.username = "openpims_app";
      appUrl.password = appPassword;

      const admin = postgres(adminUrl, { max: 1 });
      let owner: ReturnType<typeof postgres> | undefined;
      let app: ReturnType<typeof postgres> | undefined;
      let writer: ReturnType<typeof postgres> | undefined;
      let databaseCreated = false;

      const ids = {
        practice: randomUUID(),
        practiceB: randomUUID(),
        admin: randomUUID(),
        adminB: randomUUID(),
        staff: randomUUID(),
        client: randomUUID(),
        clientB: randomUUID(),
        invoice: randomUUID(),
        invoiceB: randomUUID(),
        cash: randomUUID(),
        online: randomUUID(),
        refund: randomUUID(),
        settlement: randomUUID(),
        refundEvidence: randomUUID(),
        payout: randomUUID(),
        dispute: randomUUID(),
      };
      const accountId = `acct_close_${suffix}`;

      try {
        await admin.unsafe(`create database "${databaseName}"`);
        databaseCreated = true;
        runDatabaseSetup(databaseUrl.toString(), appPassword);

        owner = postgres(databaseUrl.toString(), { max: 6 });
        app = postgres(appUrl.toString(), { max: 6 });
        writer = postgres(databaseUrl.toString(), { max: 1 });
        const ownerDb = drizzle(owner, { schema });
        const appDb = drizzle(app, { schema });

        await owner`insert into practices (id, name, timezone) values
        (${ids.practice}, 'Synthetic financial close clinic', 'America/New_York'),
        (${ids.practiceB}, 'Other financial close clinic', 'UTC')`;
        await owner`insert into users
        (id, email, password_hash, name, role, practice_id) values
        (${ids.admin}, ${`close-admin-${suffix}@example.invalid`}, 'synthetic',
         'Synthetic admin', 'admin', ${ids.practice}),
        (${ids.staff}, ${`close-staff-${suffix}@example.invalid`}, 'synthetic',
         'Synthetic staff', 'front_desk', ${ids.practice}),
        (${ids.adminB}, ${`close-admin-b-${suffix}@example.invalid`}, 'synthetic',
         'Other admin', 'admin', ${ids.practiceB})`;
        await owner`insert into clients
        (id, practice_id, first_name, last_name) values
        (${ids.client}, ${ids.practice}, 'Synthetic', 'Owner'),
        (${ids.clientB}, ${ids.practiceB}, 'Other', 'Owner')`;
        await owner`insert into invoices
        (id, practice_id, client_id, status, subtotal, tax, total, paid_amount)
        values
        (${ids.invoice}, ${ids.practice}, ${ids.client}, 'paid',
          '100.00', '0.00', '100.00', '75.00'),
        (${ids.invoiceB}, ${ids.practiceB}, ${ids.clientB}, 'draft',
          '0.00', '0.00', '0.00', '0.00')`;
        await owner`insert into practice_payment_accounts
        (practice_id, provider, stripe_account_id, onboarding_status,
         charges_enabled, payouts_enabled, details_submitted)
        values (${ids.practice}, 'stripe_connect', ${accountId}, 'active',
          true, true, true)`;
        await owner`insert into payments
        (id, invoice_id, amount, method, received_by, received_at, external_id)
        values
        (${ids.cash}, ${ids.invoice}, '40.00', 'cash', ${ids.admin},
          '2026-03-08T06:00:00.000Z', null),
        (${ids.online}, ${ids.invoice}, '60.00', 'online', ${ids.admin},
          '2026-03-08T20:00:00.000Z',
          ${`stripe:connect:${accountId}:checkout:cs_${suffix}`}),
        (${ids.refund}, ${ids.invoice}, '-25.00', 'online', ${ids.admin},
          '2026-03-08T22:00:00.000Z', ${`refund:payment:${ids.online}`})`;
        await owner`insert into payment_processor_settlements
        (id, practice_id, invoice_id, payment_id, provider,
         connected_account_id, checkout_session_id, payment_intent_id,
         charge_id, balance_transaction_id, currency, gross_amount_cents,
         processor_fee_cents, application_fee_cents, clinic_net_cents,
         balance_status, available_on, payout_id, payout_status,
         reconciled_at, last_synced_at)
        values (${ids.settlement}, ${ids.practice}, ${ids.invoice}, ${ids.online},
          'stripe_connect', ${accountId}, ${`cs_${suffix}`}, ${`pi_${suffix}`},
          ${`ch_${suffix}`}, ${`txn_${suffix}`}, 'usd', 6000, 180, 120, 5700,
          'available', '2026-03-08T21:00:00.000Z', ${`po_${suffix}`}, 'paid',
          '2026-03-08T21:00:00.000Z', '2026-03-08T21:00:00.000Z')`;
        await owner`insert into payment_processor_payouts
        (id, practice_id, provider, connected_account_id, external_payout_id,
         currency, amount_cents, status, automatic, reconciliation_complete,
         arrival_at, provider_created_at, last_synced_at)
        values (${ids.payout}, ${ids.practice}, 'stripe_connect', ${accountId},
          ${`po_${suffix}`}, 'usd', 5700, 'paid', true, true,
          '2026-03-08T23:00:00.000Z', '2026-03-08T22:00:00.000Z',
          '2026-03-08T23:00:00.000Z')`;
        await owner`insert into payment_disputes
        (id, practice_id, settlement_id, provider, external_dispute_id,
         charge_id, status, amount_cents, currency, provider_created_at,
         last_synced_at)
        values (${ids.dispute}, ${ids.practice}, ${ids.settlement},
          'stripe_connect', ${`dp_${suffix}`}, ${`ch_${suffix}`}, 'warning_needs_response',
          1000, 'usd', '2026-03-08T23:30:00.000Z',
          '2026-03-08T23:30:00.000Z')`;

        const currentDay = await withTenant(appDb, ids.practice, (tx) =>
          loadFinancialDayStatement(tx, ids.practice),
        );
        expect(currentDay).toMatchObject({
          blocker: "day_not_ended",
          canClose: false,
        });
        await expect(
          withTenant(appDb, ids.practice, (tx) =>
            closeFinancialDay(tx, {
              practiceId: ids.practice,
              closedBy: ids.admin,
              businessDate: currentDay.businessDate,
            }),
          ),
        ).rejects.toMatchObject({ reason: "day_not_ended" });

        const blocked = await withTenant(appDb, ids.practice, (tx) =>
          loadFinancialDayStatement(tx, ids.practice, "2026-03-08"),
        );
        expect(blocked).toMatchObject({
          startAt: new Date("2026-03-08T05:00:00.000Z"),
          cutoffAt: new Date("2026-03-09T04:00:00.000Z"),
          paymentCount: 3,
          grossReceiptsCents: 10_000,
          refundsCents: 2_500,
          netReceiptsCents: 7_500,
          cashCents: 4_000,
          cardAndOnlineCents: 3_500,
          processorGrossCents: 6_000,
          paidOutCents: 5_700,
          openDisputeCents: 1_000,
          unresolvedRefundCount: 1,
          unreconciledCount: 1,
          blocker: "unreconciled_items",
        });
        await expect(
          withTenant(appDb, ids.practice, (tx) =>
            closeFinancialDay(tx, {
              practiceId: ids.practice,
              closedBy: ids.admin,
              businessDate: "2026-03-08",
            }),
          ),
        ).rejects.toMatchObject({ reason: "unreconciled_items" });

        await owner`insert into payment_processor_refunds
        (id, practice_id, settlement_id, original_payment_id,
         refund_payment_id, provider, connected_account_id, external_refund_id,
         balance_transaction_id, currency, amount_cents, balance_amount_cents,
         balance_fee_cents, balance_net_cents, status, provider_created_at,
         last_synced_at)
        values (${ids.refundEvidence}, ${ids.practice}, ${ids.settlement},
          ${ids.online}, ${ids.refund}, 'stripe_connect', ${accountId},
          ${`re_${suffix}`}, ${`refund_txn_${suffix}`}, 'usd', 2500, -2500,
          0, -2500, 'succeeded', '2026-03-08T22:00:00.000Z',
          '2026-03-08T22:00:00.000Z')`;

        const created = await withTenant(appDb, ids.practice, (tx) =>
          closeFinancialDay(tx, {
            practiceId: ids.practice,
            closedBy: ids.admin,
            businessDate: "2026-03-08",
          }),
        );
        expect(created).toMatchObject({
          created: true,
          close: {
            practiceId: ids.practice,
            businessDate: "2026-03-08",
            timezone: "America/New_York",
            paymentCount: 3,
            netReceiptsCents: 7_500,
            unreconciledCount: 0,
          },
        });
        await expect(
          withTenant(appDb, ids.practice, (tx) =>
            closeFinancialDay(tx, {
              practiceId: ids.practice,
              closedBy: ids.admin,
              businessDate: "2026-03-08",
            }),
          ),
        ).resolves.toMatchObject({
          created: false,
          close: { id: created.close.id },
        });

        await expectConstraint(
          withTenant(appDb, ids.practice, (tx) =>
            tx.execute(drizzleSql`
            insert into financial_closes
              (practice_id, business_date, timezone, cutoff_at, closed_by,
               payment_count, gross_receipts_cents, refunds_cents,
               net_receipts_cents, cash_cents, check_cents,
               card_and_online_cents, other_cents, processor_gross_cents,
               processor_fee_cents, application_fee_cents, clinic_net_cents,
               paid_out_cents, open_dispute_cents, unreconciled_count)
            values (${ids.practiceB}::uuid, '2026-03-04', 'UTC',
              '2026-03-05T00:00:00.000Z', ${ids.adminB}::uuid,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
          `),
          ),
          "financial_closes_tenant_context_guard",
        );
        await expectConstraint(
          withTenant(appDb, ids.practice, (tx) =>
            tx.execute(drizzleSql`
            insert into payments
              (invoice_id, amount, method, received_by, received_at)
            values (${ids.invoiceB}::uuid, '1.00', 'cash', ${ids.adminB}::uuid,
              '2026-03-04T12:00:00.000Z')
          `),
          ),
          "payments_financial_close_tenant_guard",
        );
        await expectConstraint(
          withTenant(appDb, ids.practice, (tx) =>
            tx.execute(drizzleSql`
            update invoices set practice_id = ${ids.practiceB}::uuid
            where id = ${ids.invoice}::uuid
          `),
          ),
          "invoices_financial_close_tenant_guard",
        );
        await expectConstraint(
          owner`update financial_closes set net_receipts_cents = 1
          where id = ${created.close.id}`,
          "financial_closes_immutable_guard",
        );
        await expectConstraint(
          owner`delete from financial_closes where id = ${created.close.id}`,
          "financial_closes_immutable_guard",
        );
        await expectConstraint(
          owner`update payments set amount = '41.00' where id = ${ids.cash}`,
          "payments_financial_close_guard",
        );
        await expectConstraint(
          owner`delete from payments where id = ${ids.refund}`,
          "payments_financial_close_guard",
        );
        await expectConstraint(
          owner`update invoices set deleted_at = now() where id = ${ids.invoice}`,
          "invoices_financial_close_guard",
        );
        await expect(
          owner`update payments set notes = 'operator note' where id = ${ids.cash}`,
        ).resolves.toHaveLength(0);
        await expectConstraint(
          owner`insert into financial_closes
          (practice_id, business_date, timezone, cutoff_at, closed_by,
           payment_count, gross_receipts_cents, refunds_cents,
           net_receipts_cents, cash_cents, check_cents, card_and_online_cents,
           other_cents, processor_gross_cents, processor_fee_cents,
           application_fee_cents, clinic_net_cents, paid_out_cents,
           open_dispute_cents, unreconciled_count)
          values (${ids.practice}, '2026-03-06', 'America/New_York',
            '2026-03-07T05:00:00.000Z', ${ids.admin}, 1, 100, 0, 100,
            100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
          "financial_closes_snapshot_guard",
        );
        await expectConstraint(
          owner`insert into financial_closes
          (practice_id, business_date, timezone, cutoff_at, closed_by,
           payment_count, gross_receipts_cents, refunds_cents,
           net_receipts_cents, cash_cents, check_cents, card_and_online_cents,
           other_cents, processor_gross_cents, processor_fee_cents,
           application_fee_cents, clinic_net_cents, paid_out_cents,
           open_dispute_cents, unreconciled_count)
          values (${ids.practice}, '2026-03-05', 'America/New_York',
            '2026-03-06T05:00:00.000Z', ${ids.staff}, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
          "financial_closes_active_admin_guard",
        );

        const closeHeld = deferred();
        const releaseClose = deferred();
        const raceResult =
          deferred<Awaited<ReturnType<typeof closeFinancialDay>>>();
        const closePromise = ownerDb.transaction(async (tx) => {
          const result = await closeFinancialDay(tx, {
            practiceId: ids.practice,
            closedBy: ids.admin,
            businessDate: "2026-03-07",
          });
          raceResult.resolve(result);
          closeHeld.resolve();
          await releaseClose.promise;
          return result;
        });
        await within(closeHeld.promise, "close transaction start");
        expect(await raceResult.promise).toMatchObject({ created: true });

        const writerPid = deferred<number>();
        const latePaymentId = randomUUID();
        const writerPromise = writer.begin(async (tx) => {
          const txSql = tx as unknown as ReturnType<typeof postgres>;
          const [pidRow] = await txSql`select pg_backend_pid()::int as pid`;
          writerPid.resolve(Number(pidRow?.pid));
          return txSql`insert into payments
          (id, invoice_id, amount, method, received_by, received_at)
          values (${latePaymentId}, ${ids.invoice}, '9.00', 'cash', ${ids.admin},
            '2026-03-07T12:00:00.000Z')`;
        });
        await within(
          waitUntilBlocked(admin, await writerPid.promise),
          "payment writer lock observation",
        );
        releaseClose.resolve();
        await within(closePromise, "close transaction commit");
        await expectConstraint(
          within(writerPromise, "serialized payment writer"),
          "payments_financial_close_guard",
        );

        const [latePayment] =
          await owner`select id from payments where id = ${latePaymentId}`;
        expect(latePayment).toBeUndefined();
      } finally {
        if (writer) await writer.end({ timeout: 1 }).catch(() => undefined);
        if (app) await app.end({ timeout: 1 }).catch(() => undefined);
        if (owner) await owner.end({ timeout: 1 }).catch(() => undefined);
        if (databaseCreated) {
          await admin.unsafe(`drop database "${databaseName}" with (force)`);
        }
        await admin.end({ timeout: 1 }).catch(() => undefined);
      }
    }, 90_000);
  },
);
