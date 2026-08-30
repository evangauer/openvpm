import { eq, sql } from "drizzle-orm";
import { financialCloses } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";

export const FINANCIAL_BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isFinancialBusinessDate(value: string): boolean {
  if (!FINANCIAL_BUSINESS_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export type FinancialCloseBlocker =
  | "day_not_ended"
  | "unreconciled_items"
  | "already_closed"
  | null;

export interface FinancialDayStatement {
  businessDate: string;
  timezone: string;
  databaseNow: Date;
  startAt: Date;
  cutoffAt: Date;
  paymentCount: number;
  grossReceiptsCents: number;
  refundsCents: number;
  netReceiptsCents: number;
  cashCents: number;
  checkCents: number;
  cardAndOnlineCents: number;
  otherCents: number;
  processorGrossCents: number;
  processorFeeCents: number;
  applicationFeeCents: number;
  clinicNetCents: number;
  paidOutCents: number;
  openDisputeCents: number;
  unreconciledPaymentCount: number;
  unresolvedRefundCount: number;
  unreconciledPayoutCount: number;
  unreconciledCount: number;
  existingCloseId: string | null;
  closedAt: Date | null;
  canClose: boolean;
  blocker: FinancialCloseBlocker;
}

export interface FinancialCloseResult {
  created: boolean;
  close: typeof financialCloses.$inferSelect;
}

type FinancialCloseDatabase = Pick<Database, "execute" | "select" | "insert">;

type FinancialDayRow = {
  businessDate: string;
  timezone: string;
  databaseNow: Date | string;
  startAt: Date | string;
  cutoffAt: Date | string;
  paymentCount: number | string;
  grossReceiptsCents: number | string;
  refundsCents: number | string;
  netReceiptsCents: number | string;
  cashCents: number | string;
  checkCents: number | string;
  cardAndOnlineCents: number | string;
  otherCents: number | string;
  processorGrossCents: number | string;
  processorFeeCents: number | string;
  applicationFeeCents: number | string;
  clinicNetCents: number | string;
  paidOutCents: number | string;
  openDisputeCents: number | string;
  unreconciledPaymentCount: number | string;
  unresolvedRefundCount: number | string;
  unreconciledPayoutCount: number | string;
  existingCloseId: string | null;
  closedAt: Date | string | null;
};

export class FinancialCloseBlockedError extends Error {
  constructor(
    readonly reason: Exclude<FinancialCloseBlocker, "already_closed" | null>,
    readonly statement: FinancialDayStatement,
  ) {
    super(
      reason === "day_not_ended"
        ? "This clinic day has not ended in the practice timezone."
        : "Unresolved financial items must be reconciled before this clinic day can close.",
    );
    this.name = "FinancialCloseBlockedError";
  }
}

function integer(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Financial close returned an invalid ${label}.`);
  }
  return parsed;
}

function instant(value: Date | string, label: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Financial close returned an invalid ${label}.`);
  }
  return parsed;
}

function optionalInstant(value: Date | string | null): Date | null {
  return value === null ? null : instant(value, "close timestamp");
}

function requestedBusinessDate(value?: string | null): string | null {
  if (value == null) return null;
  if (!isFinancialBusinessDate(value)) {
    throw new Error("Financial business date must be a real YYYY-MM-DD date.");
  }
  return value;
}

/**
 * Read one clinic day from a single PostgreSQL statement snapshot. The
 * statement is provider-free and uses the database clock plus the practice's
 * stored IANA timezone. Once a day is closed, the immutable stored snapshot is
 * returned instead of recomputing history from mutable operational tables.
 */
export async function loadFinancialDayStatement(
  database: FinancialCloseDatabase,
  practiceId: string,
  businessDate?: string | null,
): Promise<FinancialDayStatement> {
  const requestedDate = requestedBusinessDate(businessDate);
  const result = await database.execute<FinancialDayRow>(sql`
    with practice_scope as (
      select
        p.timezone,
        clock_timestamp() as database_now
      from practices p
      where p.id = ${practiceId}::uuid
        and p.deleted_at is null
    ), requested_day as (
      select
        ps.timezone,
        ps.database_now,
        case
          when ${requestedDate}::text is null
            then (ps.database_now at time zone ps.timezone)::date
          else ${requestedDate}::date
        end as business_date
      from practice_scope ps
    ), bounds as (
      select
        rd.timezone,
        rd.database_now,
        rd.business_date,
        (rd.business_date::timestamp at time zone rd.timezone) as start_at,
        ((rd.business_date + 1)::timestamp at time zone rd.timezone) as cutoff_at
      from requested_day rd
    ), payment_rows as (
      select
        pay.id,
        round(pay.amount::numeric * 100)::bigint as amount_cents,
        pay.method::text as method,
        pay.external_id
      from payments pay
      join invoices i on i.id = pay.invoice_id
      cross join bounds b
      where i.practice_id = ${practiceId}::uuid
        and i.deleted_at is null
        and pay.deleted_at is null
        and pay.received_at >= b.start_at
        and pay.received_at < b.cutoff_at
    ), payment_totals as (
      select
        count(*)::bigint as payment_count,
        coalesce(sum(greatest(amount_cents, 0)), 0)::bigint as gross_receipts_cents,
        coalesce(sum(abs(least(amount_cents, 0))), 0)::bigint as refunds_cents,
        coalesce(sum(amount_cents), 0)::bigint as net_receipts_cents,
        coalesce(sum(amount_cents) filter (where method = 'cash'), 0)::bigint as cash_cents,
        coalesce(sum(amount_cents) filter (where method = 'check'), 0)::bigint as check_cents,
        coalesce(sum(amount_cents) filter (
          where method in ('credit_card', 'debit_card', 'online')
        ), 0)::bigint as card_and_online_cents,
        coalesce(sum(amount_cents) filter (where method = 'other'), 0)::bigint as other_cents
      from payment_rows
    ), processor_totals as (
      select
        coalesce(sum(s.gross_amount_cents), 0)::bigint as processor_gross_cents,
        coalesce(sum(s.processor_fee_cents), 0)::bigint as processor_fee_cents,
        coalesce(sum(s.application_fee_cents), 0)::bigint as application_fee_cents,
        coalesce(sum(s.clinic_net_cents), 0)::bigint as clinic_net_cents
      from payment_processor_settlements s
      join payment_rows pr on pr.id = s.payment_id
      where s.practice_id = ${practiceId}::uuid
        and s.deleted_at is null
    ), payout_totals as (
      select
        coalesce(sum(p.amount_cents) filter (
          where p.status = 'paid' and p.reconciliation_complete
        ), 0)::bigint as paid_out_cents,
        count(*) filter (where not p.reconciliation_complete)::bigint
          as unreconciled_payout_count
      from payment_processor_payouts p
      cross join bounds b
      where p.practice_id = ${practiceId}::uuid
        and p.deleted_at is null
        and p.arrival_at >= b.start_at
        and p.arrival_at < b.cutoff_at
    ), payment_exceptions as (
      select
        count(*) filter (
          where pr.amount_cents > 0
            and pr.method = 'online'
            and pr.external_id like 'stripe:connect:%'
            and s.id is null
        )::bigint as unreconciled_payment_count,
        count(*) filter (
          where pr.amount_cents < 0
            and pr.method = 'online'
            and pr.external_id like 'refund:payment:%'
            and (r.id is null or r.status <> 'succeeded')
        )::bigint as unresolved_refund_count
      from payment_rows pr
      left join payment_processor_settlements s
        on s.payment_id = pr.id
       and s.practice_id = ${practiceId}::uuid
       and s.deleted_at is null
      left join payment_processor_refunds r
        on r.refund_payment_id = pr.id
       and r.practice_id = ${practiceId}::uuid
       and r.deleted_at is null
    ), dispute_totals as (
      select coalesce(sum(d.amount_cents), 0)::bigint as open_dispute_cents
      from payment_disputes d
      cross join bounds b
      where d.practice_id = ${practiceId}::uuid
        and d.deleted_at is null
        and d.provider_created_at < b.cutoff_at
        and (d.closed_at is null or d.closed_at >= b.cutoff_at)
    ), existing_close as (
      select fc.*
      from financial_closes fc
      cross join bounds b
      where fc.practice_id = ${practiceId}::uuid
        and fc.business_date = b.business_date
        and fc.deleted_at is null
      limit 1
    )
    select
      b.business_date::text as "businessDate",
      b.timezone,
      b.database_now as "databaseNow",
      b.start_at as "startAt",
      b.cutoff_at as "cutoffAt",
      coalesce(fc.payment_count, pt.payment_count)::bigint as "paymentCount",
      coalesce(fc.gross_receipts_cents, pt.gross_receipts_cents)::bigint as "grossReceiptsCents",
      coalesce(fc.refunds_cents, pt.refunds_cents)::bigint as "refundsCents",
      coalesce(fc.net_receipts_cents, pt.net_receipts_cents)::bigint as "netReceiptsCents",
      coalesce(fc.cash_cents, pt.cash_cents)::bigint as "cashCents",
      coalesce(fc.check_cents, pt.check_cents)::bigint as "checkCents",
      coalesce(fc.card_and_online_cents, pt.card_and_online_cents)::bigint as "cardAndOnlineCents",
      coalesce(fc.other_cents, pt.other_cents)::bigint as "otherCents",
      coalesce(fc.processor_gross_cents, st.processor_gross_cents)::bigint as "processorGrossCents",
      coalesce(fc.processor_fee_cents, st.processor_fee_cents)::bigint as "processorFeeCents",
      coalesce(fc.application_fee_cents, st.application_fee_cents)::bigint as "applicationFeeCents",
      coalesce(fc.clinic_net_cents, st.clinic_net_cents)::bigint as "clinicNetCents",
      coalesce(fc.paid_out_cents, po.paid_out_cents)::bigint as "paidOutCents",
      coalesce(fc.open_dispute_cents, dt.open_dispute_cents)::bigint as "openDisputeCents",
      case when fc.id is null then ex.unreconciled_payment_count else 0 end::bigint
        as "unreconciledPaymentCount",
      case when fc.id is null then ex.unresolved_refund_count else 0 end::bigint
        as "unresolvedRefundCount",
      case when fc.id is null then po.unreconciled_payout_count else 0 end::bigint
        as "unreconciledPayoutCount",
      fc.id as "existingCloseId",
      fc.created_at as "closedAt"
    from bounds b
    cross join payment_totals pt
    cross join processor_totals st
    cross join payout_totals po
    cross join payment_exceptions ex
    cross join dispute_totals dt
    left join existing_close fc on true
  `);
  const row = rowsFromExecute<FinancialDayRow>(result)[0];
  if (!row) throw new Error("Practice not found for financial close.");

  const databaseNow = instant(row.databaseNow, "database clock");
  const cutoffAt = instant(row.cutoffAt, "clinic-day cutoff");
  const existingCloseId = row.existingCloseId ?? null;
  const unreconciledPaymentCount = integer(
    row.unreconciledPaymentCount,
    "unreconciled payment count",
  );
  const unresolvedRefundCount = integer(
    row.unresolvedRefundCount,
    "unresolved refund count",
  );
  const unreconciledPayoutCount = integer(
    row.unreconciledPayoutCount,
    "unreconciled payout count",
  );
  const unreconciledCount =
    unreconciledPaymentCount + unresolvedRefundCount + unreconciledPayoutCount;
  const blocker: FinancialCloseBlocker = existingCloseId
    ? "already_closed"
    : databaseNow.getTime() < cutoffAt.getTime()
      ? "day_not_ended"
      : unreconciledCount > 0
        ? "unreconciled_items"
        : null;

  const statement: FinancialDayStatement = {
    businessDate: row.businessDate,
    timezone: row.timezone,
    databaseNow,
    startAt: instant(row.startAt, "clinic-day start"),
    cutoffAt,
    paymentCount: integer(row.paymentCount, "payment count"),
    grossReceiptsCents: integer(row.grossReceiptsCents, "gross receipts"),
    refundsCents: integer(row.refundsCents, "refund total"),
    netReceiptsCents: integer(row.netReceiptsCents, "net receipts"),
    cashCents: integer(row.cashCents, "cash total"),
    checkCents: integer(row.checkCents, "check total"),
    cardAndOnlineCents: integer(
      row.cardAndOnlineCents,
      "card and online total",
    ),
    otherCents: integer(row.otherCents, "other payment total"),
    processorGrossCents: integer(row.processorGrossCents, "processor gross"),
    processorFeeCents: integer(row.processorFeeCents, "processor fees"),
    applicationFeeCents: integer(row.applicationFeeCents, "application fees"),
    clinicNetCents: integer(row.clinicNetCents, "clinic net"),
    paidOutCents: integer(row.paidOutCents, "paid-out total"),
    openDisputeCents: integer(row.openDisputeCents, "open disputes"),
    unreconciledPaymentCount,
    unresolvedRefundCount,
    unreconciledPayoutCount,
    unreconciledCount,
    existingCloseId,
    closedAt: optionalInstant(row.closedAt),
    canClose: blocker === null,
    blocker,
  };

  if (
    statement.netReceiptsCents !==
      statement.grossReceiptsCents - statement.refundsCents ||
    statement.processorGrossCents !==
      statement.processorFeeCents +
        statement.applicationFeeCents +
        statement.clinicNetCents
  ) {
    throw new Error("Financial close accounting identity failed.");
  }
  return statement;
}

const POSTGRES_INTEGER_MIN = -2_147_483_648;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function assertStoredInteger(value: number, label: string): void {
  if (value < POSTGRES_INTEGER_MIN || value > POSTGRES_INTEGER_MAX) {
    throw new Error(`Financial close ${label} exceeds the supported range.`);
  }
}

function assertStatementStorageBounds(statement: FinancialDayStatement): void {
  const values: Array<[number, string]> = [
    [statement.paymentCount, "payment count"],
    [statement.grossReceiptsCents, "gross receipts"],
    [statement.refundsCents, "refund total"],
    [statement.netReceiptsCents, "net receipts"],
    [statement.cashCents, "cash total"],
    [statement.checkCents, "check total"],
    [statement.cardAndOnlineCents, "card and online total"],
    [statement.otherCents, "other payment total"],
    [statement.processorGrossCents, "processor gross"],
    [statement.processorFeeCents, "processor fees"],
    [statement.applicationFeeCents, "application fees"],
    [statement.clinicNetCents, "clinic net"],
    [statement.paidOutCents, "paid-out total"],
    [statement.openDisputeCents, "open disputes"],
    [statement.unreconciledCount, "unreconciled count"],
  ];
  for (const [value, label] of values) assertStoredInteger(value, label);
}

/**
 * Close one ended clinic day. The caller must already be inside the tenant
 * transaction used by protectedProcedure. The practice row lock coordinates
 * with database payment/invoice guards, while the advisory lock makes retries
 * for the same practice/day deterministic.
 */
export async function closeFinancialDay(
  database: FinancialCloseDatabase,
  input: { practiceId: string; closedBy: string; businessDate: string },
): Promise<FinancialCloseResult> {
  const businessDate = requestedBusinessDate(input.businessDate)!;
  await database.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended('financial-close:' || ${input.practiceId} || ':' || ${businessDate}, 0)
    )
  `);
  const practiceLock = await database.execute<{ id: string }>(sql`
    select p.id
    from practices p
    where p.id = ${input.practiceId}::uuid
      and p.deleted_at is null
    for update
  `);
  if (rowsFromExecute<{ id: string }>(practiceLock).length !== 1) {
    throw new Error("Practice not found for financial close.");
  }

  const statement = await loadFinancialDayStatement(
    database,
    input.practiceId,
    businessDate,
  );
  if (statement.existingCloseId) {
    const [existing] = await database
      .select()
      .from(financialCloses)
      .where(eq(financialCloses.id, statement.existingCloseId))
      .limit(1);
    if (!existing) throw new Error("Immutable financial close is missing.");
    return { created: false, close: existing };
  }
  if (statement.blocker === "day_not_ended") {
    throw new FinancialCloseBlockedError("day_not_ended", statement);
  }
  if (statement.blocker === "unreconciled_items") {
    throw new FinancialCloseBlockedError("unreconciled_items", statement);
  }
  assertStatementStorageBounds(statement);

  const [created] = await database
    .insert(financialCloses)
    .values({
      practiceId: input.practiceId,
      businessDate: statement.businessDate,
      timezone: statement.timezone,
      cutoffAt: statement.cutoffAt,
      closedBy: input.closedBy,
      paymentCount: statement.paymentCount,
      grossReceiptsCents: statement.grossReceiptsCents,
      refundsCents: statement.refundsCents,
      netReceiptsCents: statement.netReceiptsCents,
      cashCents: statement.cashCents,
      checkCents: statement.checkCents,
      cardAndOnlineCents: statement.cardAndOnlineCents,
      otherCents: statement.otherCents,
      processorGrossCents: statement.processorGrossCents,
      processorFeeCents: statement.processorFeeCents,
      applicationFeeCents: statement.applicationFeeCents,
      clinicNetCents: statement.clinicNetCents,
      paidOutCents: statement.paidOutCents,
      openDisputeCents: statement.openDisputeCents,
      unreconciledCount: statement.unreconciledCount,
    })
    .returning();
  if (!created) throw new Error("Financial close was not created.");
  return { created: true, close: created };
}
