import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";

export const FINANCIAL_BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface FinancialDaySummary {
  businessDate: string;
  timezone: string;
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
  unreconciledCount: number;
}

type FinancialDayRow = Omit<
  FinancialDaySummary,
  "businessDate" | "startAt" | "cutoffAt"
> & {
  startAt: Date | string;
  cutoffAt: Date | string;
};

function integer(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Financial close returned a non-integer amount.");
  }
  return parsed;
}

export async function loadFinancialDaySummary(
  database: Database,
  practiceId: string,
  businessDate: string,
): Promise<FinancialDaySummary> {
  if (!FINANCIAL_BUSINESS_DATE_PATTERN.test(businessDate)) {
    throw new Error("Financial business date must be YYYY-MM-DD.");
  }

  const result = await database.execute(sql`
    with bounds as (
      select
        p.timezone,
        (${businessDate}::date::timestamp at time zone p.timezone) as start_at,
        ((${businessDate}::date + 1)::timestamp at time zone p.timezone) as cutoff_at
      from practices p
      where p.id = ${practiceId}::uuid
        and p.deleted_at is null
    ), payment_rows as (
      select
        pay.id,
        round(pay.amount * 100)::int as amount_cents,
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
        count(*)::int as payment_count,
        coalesce(sum(greatest(amount_cents, 0)), 0)::int as gross_receipts_cents,
        coalesce(sum(abs(least(amount_cents, 0))), 0)::int as refunds_cents,
        coalesce(sum(amount_cents), 0)::int as net_receipts_cents,
        coalesce(sum(amount_cents) filter (where method = 'cash'), 0)::int as cash_cents,
        coalesce(sum(amount_cents) filter (where method = 'check'), 0)::int as check_cents,
        coalesce(sum(amount_cents) filter (where method in ('credit_card', 'debit_card', 'online')), 0)::int as card_and_online_cents,
        coalesce(sum(amount_cents) filter (where method = 'other'), 0)::int as other_cents
      from payment_rows
    ), processor_totals as (
      select
        coalesce(sum(s.gross_amount_cents), 0)::int as processor_gross_cents,
        coalesce(sum(s.processor_fee_cents), 0)::int as processor_fee_cents,
        coalesce(sum(s.application_fee_cents), 0)::int as application_fee_cents,
        coalesce(sum(s.clinic_net_cents), 0)::int as clinic_net_cents
      from payment_processor_settlements s
      join payment_rows pr on pr.id = s.payment_id
      where s.practice_id = ${practiceId}::uuid
        and s.deleted_at is null
    ), payout_totals as (
      select coalesce(sum(p.amount_cents), 0)::int as paid_out_cents
      from payment_processor_payouts p
      cross join bounds b
      where p.practice_id = ${practiceId}::uuid
        and p.deleted_at is null
        and p.status = 'paid'
        and p.provider_created_at >= b.start_at
        and p.provider_created_at < b.cutoff_at
    ), exceptions as (
      select (
        count(*) filter (
          where pr.amount_cents > 0
            and pr.method = 'online'
            and pr.external_id like 'stripe:connect:%'
            and s.id is null
        ) + count(*) filter (
          where pr.amount_cents < 0
            and pr.method = 'online'
            and pr.external_id like 'refund:payment:%'
            and (r.id is null or r.status <> 'succeeded')
        )
      )::int as unreconciled_count
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
      select coalesce(sum(d.amount_cents), 0)::int as open_dispute_cents
      from payment_disputes d
      cross join bounds b
      where d.practice_id = ${practiceId}::uuid
        and d.deleted_at is null
        and d.provider_created_at < b.cutoff_at
        and (d.closed_at is null or d.closed_at >= b.cutoff_at)
    )
    select
      b.timezone,
      b.start_at as "startAt",
      b.cutoff_at as "cutoffAt",
      pt.payment_count as "paymentCount",
      pt.gross_receipts_cents as "grossReceiptsCents",
      pt.refunds_cents as "refundsCents",
      pt.net_receipts_cents as "netReceiptsCents",
      pt.cash_cents as "cashCents",
      pt.check_cents as "checkCents",
      pt.card_and_online_cents as "cardAndOnlineCents",
      pt.other_cents as "otherCents",
      st.processor_gross_cents as "processorGrossCents",
      st.processor_fee_cents as "processorFeeCents",
      st.application_fee_cents as "applicationFeeCents",
      st.clinic_net_cents as "clinicNetCents",
      po.paid_out_cents as "paidOutCents",
      dt.open_dispute_cents as "openDisputeCents",
      ex.unreconciled_count as "unreconciledCount"
    from bounds b
    cross join payment_totals pt
    cross join processor_totals st
    cross join payout_totals po
    cross join exceptions ex
    cross join dispute_totals dt
  `);
  const row = rowsFromExecute<FinancialDayRow>(result)[0];
  if (!row) throw new Error("Practice not found for financial close.");

  const summary: FinancialDaySummary = {
    businessDate,
    timezone: row.timezone,
    startAt: new Date(row.startAt),
    cutoffAt: new Date(row.cutoffAt),
    paymentCount: integer(row.paymentCount),
    grossReceiptsCents: integer(row.grossReceiptsCents),
    refundsCents: integer(row.refundsCents),
    netReceiptsCents: integer(row.netReceiptsCents),
    cashCents: integer(row.cashCents),
    checkCents: integer(row.checkCents),
    cardAndOnlineCents: integer(row.cardAndOnlineCents),
    otherCents: integer(row.otherCents),
    processorGrossCents: integer(row.processorGrossCents),
    processorFeeCents: integer(row.processorFeeCents),
    applicationFeeCents: integer(row.applicationFeeCents),
    clinicNetCents: integer(row.clinicNetCents),
    paidOutCents: integer(row.paidOutCents),
    openDisputeCents: integer(row.openDisputeCents),
    unreconciledCount: integer(row.unreconciledCount),
  };

  if (
    summary.netReceiptsCents !==
      summary.grossReceiptsCents - summary.refundsCents ||
    summary.processorGrossCents !==
      summary.processorFeeCents +
        summary.applicationFeeCents +
        summary.clinicNetCents
  ) {
    throw new Error("Financial close accounting identity failed.");
  }
  return summary;
}
