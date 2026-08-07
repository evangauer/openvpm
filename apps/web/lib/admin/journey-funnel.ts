import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { funnelRate } from "@/lib/admin/activation-funnel";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface JourneyFunnelWeek {
  weekStart: string;
  visitors: number;
  demos: number;
  registrations: number;
  activated: number;
  cardAdded: number;
  paid: number;
}

export interface JourneyFunnelTotals {
  visitors: number;
  demos: number;
  registrations: number;
  activated: number;
  cardAdded: number;
  paid: number;
  leftBeforeTrying: number;
  demoAbandoned: number;
  registrationAbandoned: number;
  activationAbandoned: number;
  cardAbandoned: number;
  unattributedRegistrations: number;
  clientErrors: number;
  demoRate: number;
  registrationRate: number;
  activationRate: number;
  cardRate: number;
  paidRate: number;
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
  cardAdded: number | string;
  paid: number | string;
  leftBeforeTrying: number | string;
  demoAbandoned: number | string;
  registrationAbandoned: number | string;
  activationAbandoned: number | string;
  cardAbandoned: number | string;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function computeJourneyFunnel(
  db: Database,
  days: number
): Promise<JourneyFunnel> {
  const windowStart = new Date(Date.now() - days * DAY_MS).toISOString();

  const { weeklyResult, unattributedResult, errorsResult } = await withSystem(db, async (tx) => {
    const weeklyResult = await tx.execute(sql`
      with first_touch as (
        select
          fe.anonymous_id,
          min(fe.created_at) as cohort_at
        from funnel_events fe
        where fe.deleted_at is null
          and fe.anonymous_id is not null
          and fe.created_at >= ${windowStart}::timestamptz
          and fe.event_name in (
            'visit', 'demo_land', 'demo_gate_viewed', 'signup_land'
          )
        group by fe.anonymous_id
      ), journeys as (
        select
          ft.anonymous_id,
          date_trunc('week', ft.cohort_at) as week_start,
          exists (
            select 1 from funnel_events demo
            where demo.anonymous_id = ft.anonymous_id
              and demo.event_name = 'demo_gate_submitted'
              and demo.deleted_at is null
          ) as tried_demo,
          (
            select registration.practice_id
            from funnel_events registration
            join practices p on p.id = registration.practice_id
            where registration.anonymous_id = ft.anonymous_id
              and registration.event_name = 'registration'
              and registration.deleted_at is null
              and p.deleted_at is null
              and p.settings ->> 'analyticsExcluded' is distinct from 'true'
            order by registration.created_at
            limit 1
          ) as practice_id
        from first_touch ft
      ), stages as (
        select
          j.*,
          exists (
            select 1 from funnel_events activation
            where activation.practice_id = j.practice_id
              and activation.event_name = 'activation'
              and activation.deleted_at is null
          ) as activated,
          exists (
            select 1 from funnel_events card
            where card.practice_id = j.practice_id
              and card.event_name = 'card_added'
              and card.deleted_at is null
          ) as card_added,
          exists (
            select 1 from funnel_events paid
            where paid.practice_id = j.practice_id
              and paid.event_name = 'paid'
              and paid.deleted_at is null
          ) as paid
        from journeys j
      )
      select
        to_char(s.week_start, 'YYYY-MM-DD') as "weekStart",
        count(*)::int as "visitors",
        count(*) filter (where s.tried_demo)::int as "demos",
        count(*) filter (where s.practice_id is not null)::int as "registrations",
        count(*) filter (where s.activated)::int as "activated",
        count(*) filter (where s.card_added)::int as "cardAdded",
        count(*) filter (where s.paid)::int as "paid",
        count(*) filter (
          where not s.tried_demo and s.practice_id is null
        )::int as "leftBeforeTrying",
        count(*) filter (
          where s.tried_demo and s.practice_id is null
        )::int as "demoAbandoned",
        count(*) filter (
          where s.practice_id is not null and not s.activated
        )::int as "registrationAbandoned",
        count(*) filter (
          where s.activated and not s.card_added
        )::int as "activationAbandoned",
        count(*) filter (
          where s.card_added and not s.paid
        )::int as "cardAbandoned"
      from stages s
      group by s.week_start
      order by s.week_start
    `);

    const unattributedResult = await tx.execute(sql`
      select count(*)::int as count
      from funnel_events registration
      join practices p on p.id = registration.practice_id
      where registration.event_name = 'registration'
        and registration.deleted_at is null
        and registration.created_at >= ${windowStart}::timestamptz
        and p.deleted_at is null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
        and (
          registration.anonymous_id is null
          or not exists (
            select 1
            from funnel_events touch
            where touch.anonymous_id = registration.anonymous_id
              and touch.deleted_at is null
              and touch.event_name in (
                'visit', 'demo_land', 'demo_gate_viewed', 'signup_land'
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
    cardAdded: Number(row.cardAdded) || 0,
    paid: Number(row.paid) || 0,
  }));

  const sum = (key: keyof Omit<JourneyRow, "weekStart">) =>
    rawWeeks.reduce((total, week) => total + (Number(week[key]) || 0), 0);
  const visitors = sum("visitors");
  const demos = sum("demos");
  const registrations = sum("registrations");
  const activated = sum("activated");
  const cardAdded = sum("cardAdded");
  const paid = sum("paid");
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
      cardAdded,
      paid,
      leftBeforeTrying: sum("leftBeforeTrying"),
      demoAbandoned: sum("demoAbandoned"),
      registrationAbandoned: sum("registrationAbandoned"),
      activationAbandoned: sum("activationAbandoned"),
      cardAbandoned: sum("cardAbandoned"),
      unattributedRegistrations: Number(unattributedRows[0]?.count) || 0,
      clientErrors: Number(errorRows[0]?.count) || 0,
      demoRate: funnelRate(demos, visitors),
      registrationRate: funnelRate(registrations, visitors),
      activationRate: funnelRate(activated, registrations),
      cardRate: funnelRate(cardAdded, activated),
      paidRate: funnelRate(paid, cardAdded),
    },
  };
}
