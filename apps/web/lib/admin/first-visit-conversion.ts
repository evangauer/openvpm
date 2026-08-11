import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { funnelRate } from "@/lib/admin/activation-funnel";
import {
  SUBSCRIPTION_CHECKOUT_SOURCES,
  type SubscriptionCheckoutSource,
} from "@/lib/billing/checkout-attribution";

const DAY_MS = 24 * 60 * 60 * 1000;
const MATURITY_HOURS = 72;

export type FirstVisitCheckoutSource = SubscriptionCheckoutSource | "unknown";

export interface FirstVisitConversionReport {
  days: number;
  maturityHours: number;
  totalFirstVisits: number;
  awaitingMaturity: number;
  alreadyCardedAtVisit: number;
  matureOpportunities: number;
  convertedWithin24Hours: number;
  convertedWithin72Hours: number;
  conversionRate24Hours: number;
  conversionRate72Hours: number;
  sourceBreakdown: Record<FirstVisitCheckoutSource, number>;
}

type TotalsRow = {
  totalFirstVisits: number | string;
  awaitingMaturity: number | string;
  alreadyCardedAtVisit: number | string;
  matureOpportunities: number | string;
  convertedWithin24Hours: number | string;
  convertedWithin72Hours: number | string;
};

type SourceRow = { source: string | null; count: number | string };

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function count(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export async function computeFirstVisitConversion(
  database: Database,
  days: number,
  now = new Date(),
): Promise<FirstVisitConversionReport> {
  const windowStart = new Date(now.getTime() - days * DAY_MS);
  const maturityCutoff = new Date(
    now.getTime() - MATURITY_HOURS * 60 * 60 * 1000,
  );

  const { totalsResult, sourceResult } = await withSystem(
    database,
    async (tx) => {
      const cohort = sql`
        with first_visits as (
          select
            p.id as practice_id,
            min(vc.completed_at) as first_visit_at
          from practices p
          join appointments a
            on a.practice_id = p.id
           and a.deleted_at is null
           and a.status = 'checked_out'
           and a.created_at >= p.created_at
          join visit_closeouts vc
            on vc.practice_id = p.id
           and vc.appointment_id = a.id
           and vc.deleted_at is null
           and vc.status = 'completed'
           and vc.completed_at is not null
           and vc.completed_at >= p.created_at
          where p.deleted_at is null
            and p.settings ->> 'analyticsExcluded' is distinct from 'true'
            and not (
              coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
                @> to_jsonb(a.id::text)
            )
          group by p.id
          having min(vc.completed_at) >= ${windowStart}
             and min(vc.completed_at) <= ${now}
        ), attributed as (
          select
            fv.*,
            before_checkout.event_created_at as carded_before_or_at,
            after_checkout.event_created_at as first_checkout_after,
            after_checkout.checkout_source as first_checkout_source
          from first_visits fv
          left join lateral (
            select se.event_created_at
            from stripe_events se
            where se.practice_id = fv.practice_id
              and se.endpoint = 'subscription'
              and se.evidence_kind = 'subscription_checkout_completed'
              and se.event_created_at is not null
              and se.event_created_at <= fv.first_visit_at
            order by se.event_created_at, se.event_id
            limit 1
          ) before_checkout on true
          left join lateral (
            select se.event_created_at, se.checkout_source
            from stripe_events se
            where se.practice_id = fv.practice_id
              and se.endpoint = 'subscription'
              and se.evidence_kind = 'subscription_checkout_completed'
              and se.event_created_at is not null
              and se.event_created_at > fv.first_visit_at
            order by se.event_created_at, se.event_id
            limit 1
          ) after_checkout on true
        )
      `;

      const totalsResult = await tx.execute(sql`
        ${cohort}
        select
          count(*)::int as "totalFirstVisits",
          count(*) filter (
            where first_visit_at > ${maturityCutoff}
              and carded_before_or_at is null
          )::int as "awaitingMaturity",
          count(*) filter (
            where carded_before_or_at is not null
          )::int as "alreadyCardedAtVisit",
          count(*) filter (
            where first_visit_at <= ${maturityCutoff}
              and carded_before_or_at is null
          )::int as "matureOpportunities",
          count(*) filter (
            where first_visit_at <= ${maturityCutoff}
              and carded_before_or_at is null
              and first_checkout_after > first_visit_at
              and first_checkout_after <= first_visit_at + interval '24 hours'
          )::int as "convertedWithin24Hours",
          count(*) filter (
            where first_visit_at <= ${maturityCutoff}
              and carded_before_or_at is null
              and first_checkout_after > first_visit_at
              and first_checkout_after <= first_visit_at + interval '72 hours'
          )::int as "convertedWithin72Hours"
        from attributed
      `);
      const sourceResult = await tx.execute(sql`
        ${cohort}
        select
          coalesce(first_checkout_source::text, 'unknown') as source,
          count(*)::int as count
        from attributed
        where first_visit_at <= ${maturityCutoff}
          and carded_before_or_at is null
          and first_checkout_after > first_visit_at
          and first_checkout_after <= first_visit_at + interval '72 hours'
        group by coalesce(first_checkout_source::text, 'unknown')
        order by source
      `);
      return { totalsResult, sourceResult };
    },
  );

  const totals = rowsFromExecute<TotalsRow>(totalsResult)[0];
  const sourceBreakdown = Object.fromEntries(
    [...SUBSCRIPTION_CHECKOUT_SOURCES, "unknown"].map((source) => [source, 0]),
  ) as Record<FirstVisitCheckoutSource, number>;
  for (const row of rowsFromExecute<SourceRow>(sourceResult)) {
    const source = SUBSCRIPTION_CHECKOUT_SOURCES.includes(
      row.source as SubscriptionCheckoutSource,
    )
      ? (row.source as SubscriptionCheckoutSource)
      : "unknown";
    sourceBreakdown[source] += count(row.count);
  }

  const matureOpportunities = count(totals?.matureOpportunities);
  const convertedWithin24Hours = count(totals?.convertedWithin24Hours);
  const convertedWithin72Hours = count(totals?.convertedWithin72Hours);
  return {
    days,
    maturityHours: MATURITY_HOURS,
    totalFirstVisits: count(totals?.totalFirstVisits),
    awaitingMaturity: count(totals?.awaitingMaturity),
    alreadyCardedAtVisit: count(totals?.alreadyCardedAtVisit),
    matureOpportunities,
    convertedWithin24Hours,
    convertedWithin72Hours,
    conversionRate24Hours: funnelRate(
      convertedWithin24Hours,
      matureOpportunities,
    ),
    conversionRate72Hours: funnelRate(
      convertedWithin72Hours,
      matureOpportunities,
    ),
    sourceBreakdown,
  };
}
