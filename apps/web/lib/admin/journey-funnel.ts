import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { funnelRate } from "@/lib/admin/activation-funnel";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ABANDONMENT_GRACE_DAYS = 7;

export interface JourneyFunnelWeek {
  weekStart: string;
  visitors: number;
  demos: number;
  registrations: number;
  activated: number;
  paymentMethodCollected: number;
  firstPositivePayment: number;
}

export interface JourneyFunnelTotals {
  visitors: number;
  demos: number;
  registrations: number;
  activated: number;
  paymentMethodCollected: number;
  firstPositivePayment: number;
  leftBeforeTrying: number;
  demoAbandoned: number;
  registrationAbandoned: number;
  activationAbandoned: number;
  paymentAbandoned: number;
  unattributedRegistrations: number;
  clientErrors: number;
  demoRate: number;
  registrationRate: number;
  activationRate: number;
  paymentMethodRate: number;
  positivePaymentRate: number;
}

export interface JourneyFunnel {
  days: number;
  weeks: JourneyFunnelWeek[];
  totals: JourneyFunnelTotals;
}

interface JourneyRow {
  weekStart: string;
  visitors: number | string;
  demos: number | string;
  registrations: number | string;
  activated: number | string;
  paymentMethodCollected: number | string;
  firstPositivePayment: number | string;
  leftBeforeTrying: number | string;
  demoAbandoned: number | string;
  registrationAbandoned: number | string;
  activationAbandoned: number | string;
  paymentAbandoned: number | string;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function computeJourneyFunnel(
  db: Database,
  days: number,
  now: Date = new Date()
): Promise<JourneyFunnel> {
  const windowStart = new Date(now.getTime() - days * DAY_MS).toISOString();
  const abandonedBefore = new Date(
    now.getTime() - ABANDONMENT_GRACE_DAYS * DAY_MS
  ).toISOString();

  const { weeklyResult, unattributedResult, errorsResult } = await withSystem(db, async (tx) => {
    const weeklyResult = await tx.execute(sql`
      with first_touch_all_time as (
        select
          fe.anonymous_id,
          min(fe.created_at) as cohort_at
        from funnel_events fe
        where fe.deleted_at is null
          and fe.anonymous_id is not null
          and fe.event_name in (
            'visit', 'demo_land', 'demo_gate_viewed', 'demo_gate_submitted',
            'signup_land'
          )
        group by fe.anonymous_id
      ), first_touch as (
        select anonymous_id, cohort_at
        from first_touch_all_time
        where cohort_at >= ${windowStart}::timestamptz
      ), journeys as (
        select
          ft.anonymous_id,
          ft.cohort_at,
          date_trunc('week', ft.cohort_at) as week_start,
          demo.demo_at,
          demo.demo_at is not null as tried_demo,
          registration.practice_id,
          registration.registered_at
        from first_touch ft
        left join lateral (
          select min(demo.created_at) as demo_at
          from funnel_events demo
          where demo.anonymous_id = ft.anonymous_id
            and demo.event_name = 'demo_gate_submitted'
            and demo.deleted_at is null
            and demo.created_at >= ft.cohort_at
        ) demo on true
        left join lateral (
            select
              p.id as practice_id,
              registered.occurred_at as registered_at
            from practices p
            join practice_conversion_milestones registered
              on registered.practice_id = p.id
             and registered.milestone = 'registered'
            where lower(p.settings -> 'acquisition' ->> 'funnelId') = ft.anonymous_id
              and p.deleted_at is null
              and p.settings ->> 'analyticsExcluded' is distinct from 'true'
            order by p.created_at, p.id
            limit 1
        ) registration on true
      ), stages as (
        select
          j.*,
          (
            select min(activation.occurred_at)
            from practice_conversion_milestones activation
            where activation.practice_id = j.practice_id
              and activation.milestone = 'activated'
          ) as activation_at,
          (
            select min(payment_method.occurred_at)
            from practice_conversion_milestones payment_method
            where payment_method.practice_id = j.practice_id
              and payment_method.milestone = 'payment_method_collected'
          ) as payment_method_at,
          (
            select min(positive_payment.occurred_at)
            from practice_conversion_milestones positive_payment
            where positive_payment.practice_id = j.practice_id
              and positive_payment.milestone = 'first_positive_payment'
          ) as positive_payment_at,
          p.billing_status,
          p.trial_ends_at,
          p.stripe_subscription_id
        from journeys j
        left join practices p on p.id = j.practice_id
      )
      select
        to_char(s.week_start, 'YYYY-MM-DD') as "weekStart",
        count(*)::int as "visitors",
        count(*) filter (where s.tried_demo)::int as "demos",
        count(*) filter (where s.practice_id is not null)::int as "registrations",
        count(*) filter (where s.activation_at is not null)::int as "activated",
        count(*) filter (
          where s.activation_at is not null and s.payment_method_at is not null
        )::int as "paymentMethodCollected",
        count(*) filter (
          where s.activation_at is not null
            and s.payment_method_at is not null
            and s.positive_payment_at is not null
        )::int as "firstPositivePayment",
        count(*) filter (
          where not s.tried_demo
            and s.practice_id is null
            and s.cohort_at < ${abandonedBefore}::timestamptz
        )::int as "leftBeforeTrying",
        count(*) filter (
          where s.tried_demo
            and s.practice_id is null
            and s.demo_at < ${abandonedBefore}::timestamptz
        )::int as "demoAbandoned",
        count(*) filter (
          where s.practice_id is not null
            and s.activation_at is null
            and s.registered_at < ${abandonedBefore}::timestamptz
        )::int as "registrationAbandoned",
        count(*) filter (
          where s.activation_at is not null
            and s.payment_method_at is null
            and s.activation_at < ${abandonedBefore}::timestamptz
        )::int as "activationAbandoned",
        count(*) filter (
          where s.payment_method_at is not null
            and s.positive_payment_at is null
            and s.payment_method_at < ${abandonedBefore}::timestamptz
            and not (
              s.stripe_subscription_id is not null
              and s.billing_status = 'trialing'
              and s.trial_ends_at > ${now.toISOString()}::timestamptz
            )
        )::int as "paymentAbandoned"
      from stages s
      group by s.week_start
      order by s.week_start
    `);

    const unattributedResult = await tx.execute(sql`
      select count(*)::int as count
      from practices p
      where p.created_at >= ${windowStart}::timestamptz
        and p.deleted_at is null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
        and (
          not (
            coalesce(p.settings -> 'acquisition' ->> 'funnelId', '')
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          )
          or not exists (
            select 1
            from funnel_events touch
            where touch.anonymous_id = lower(
              p.settings -> 'acquisition' ->> 'funnelId'
            )
              and touch.deleted_at is null
              and touch.event_name in (
                'visit', 'demo_land', 'demo_gate_viewed',
                'demo_gate_submitted', 'signup_land'
              )
          )
        )
    `);
    const errorsResult = await tx.execute(sql`
      select count(*)::int as count
      from funnel_events
      where event_name = 'client_error'
        and deleted_at is null
        and created_at >= ${windowStart}::timestamptz
    `);
    return { weeklyResult, unattributedResult, errorsResult };
  });

  const rawWeeks = rowsFromExecute<JourneyRow>(weeklyResult);
  const weeks = rawWeeks.map((row) => ({
    weekStart: String(row.weekStart),
    visitors: Number(row.visitors) || 0,
    demos: Number(row.demos) || 0,
    registrations: Number(row.registrations) || 0,
    activated: Number(row.activated) || 0,
    paymentMethodCollected: Number(row.paymentMethodCollected) || 0,
    firstPositivePayment: Number(row.firstPositivePayment) || 0,
  }));

  const sum = (key: keyof Omit<JourneyRow, "weekStart">) =>
    rawWeeks.reduce((total, week) => total + (Number(week[key]) || 0), 0);
  const visitors = sum("visitors");
  const demos = sum("demos");
  const registrations = sum("registrations");
  const activated = sum("activated");
  const paymentMethodCollected = sum("paymentMethodCollected");
  const firstPositivePayment = sum("firstPositivePayment");
  const unattributedRows = rowsFromExecute<{ count: number | string }>(
    unattributedResult
  );
  const errorRows = rowsFromExecute<{ count: number | string }>(errorsResult);

  return {
    days,
    weeks,
    totals: {
      visitors,
      demos,
      registrations,
      activated,
      paymentMethodCollected,
      firstPositivePayment,
      leftBeforeTrying: sum("leftBeforeTrying"),
      demoAbandoned: sum("demoAbandoned"),
      registrationAbandoned: sum("registrationAbandoned"),
      activationAbandoned: sum("activationAbandoned"),
      paymentAbandoned: sum("paymentAbandoned"),
      unattributedRegistrations: Number(unattributedRows[0]?.count) || 0,
      clientErrors: Number(errorRows[0]?.count) || 0,
      demoRate: funnelRate(demos, visitors),
      registrationRate: funnelRate(registrations, visitors),
      activationRate: funnelRate(activated, registrations),
      paymentMethodRate: funnelRate(paymentMethodCollected, activated),
      positivePaymentRate: funnelRate(
        firstPositivePayment,
        paymentMethodCollected,
      ),
    },
  };
}
