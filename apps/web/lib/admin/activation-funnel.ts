import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";

/**
 * Trial activation funnel, DERIVED from existing data (no schema changes).
 *
 * - signup: a practice created inside the window (soft-deleted and explicitly
 *   analytics-excluded internal/test practices are excluded).
 * - activated: the practice has at least one real (non-demo) client AND at
 *   least one real (non-demo) appointment created after signup. Demo rows are
 *   the ids recorded in practices.settings -> 'demoData' when sample data is
 *   seeded, so they never count toward activation.
 * - billing started: a Stripe subscription exists and local status is trialing
 *   or active. This captures card-on-file commitment before the first charge.
 * - paid active: billingStatus = 'active'. A trialing subscription is not paid.
 *
 * Shared by the platform-admin tRPC query and the weekly digest cron so both
 * always report the same numbers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActivationFunnelWeek {
  /** ISO date (YYYY-MM-DD) of the Monday the week starts on. */
  weekStart: string;
  signups: number;
  setupStarted: number;
  setupCompleted: number;
  activated: number;
  billingStarted: number;
  subscribed: number;
}

export interface ActivationFunnelTotals {
  signups: number;
  setupStarted: number;
  setupCompleted: number;
  activated: number;
  billingStarted: number;
  subscribed: number;
  /** setupStarted / signups; 0 when there are no signups. */
  setupStartRate: number;
  /** setupCompleted / signups; 0 when there are no signups. */
  setupCompletionRate: number;
  /** activated / signups; 0 when there are no signups. */
  activationRate: number;
  /** billingStarted / signups; 0 when there are no signups. */
  billingStartRate: number;
  /** subscribed / signups; 0 when there are no signups. */
  conversionRate: number;
}

export interface ActivationFunnel {
  days: number;
  weeks: ActivationFunnelWeek[];
  totals: ActivationFunnelTotals;
}

/** Rate guarded against divide-by-zero: no signups means a 0 rate, not NaN. */
export function funnelRate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

interface FunnelRow {
  weekStart: string;
  signups: number | string;
  setupStarted: number | string;
  setupCompleted: number | string;
  activated: number | string;
  billingStarted: number | string;
  subscribed: number | string;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function computeActivationFunnel(
  db: Database,
  days: number
): Promise<ActivationFunnel> {
  const windowStart = new Date(Date.now() - days * DAY_MS).toISOString();

  // Cross-tenant read → system context (RLS bypass), same as the admin
  // overview. One grouped aggregate query — no per-practice N+1.
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      with signups as (
        select
          p.id,
          p.created_at,
          p.billing_status,
          p.stripe_subscription_id,
          p.settings,
          date_trunc('week', p.created_at) as week_start,
          coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb)
            as demo_client_ids,
          coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
            as demo_appointment_ids
        from practices p
        where p.deleted_at is null
          and p.created_at >= ${windowStart}::timestamptz
          and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      )
      select
        to_char(s.week_start, 'YYYY-MM-DD') as "weekStart",
        count(*)::int as "signups",
        count(*) filter (
          where nullif(s.settings -> 'onboardingState' ->> 'journeyStepId', '')
            is not null
            or nullif(s.settings ->> 'onboardingCompletedAt', '') is not null
        )::int as "setupStarted",
        count(*) filter (
          where nullif(s.settings ->> 'onboardingCompletedAt', '') is not null
        )::int as "setupCompleted",
        count(*) filter (
          where exists (
            select 1
            from clients c
            where c.practice_id = s.id
              and c.deleted_at is null
              and c.created_at >= s.created_at
              and not (s.demo_client_ids @> to_jsonb(c.id::text))
          )
          and exists (
            select 1
            from appointments a
            where a.practice_id = s.id
              and a.deleted_at is null
              and a.created_at >= s.created_at
              and not (s.demo_appointment_ids @> to_jsonb(a.id::text))
          )
        )::int as "activated",
        count(*) filter (
          where s.stripe_subscription_id is not null
            and s.billing_status in ('trialing', 'active')
        )::int as "billingStarted",
        count(*) filter (where s.billing_status = 'active')::int as "subscribed"
      from signups s
      group by s.week_start
      order by s.week_start
    `)
  );

  const weeks: ActivationFunnelWeek[] = rowsFromExecute<FunnelRow>(result).map(
    (row) => ({
      weekStart: String(row.weekStart),
      signups: Number(row.signups) || 0,
      setupStarted: Number(row.setupStarted) || 0,
      setupCompleted: Number(row.setupCompleted) || 0,
      activated: Number(row.activated) || 0,
      billingStarted: Number(row.billingStarted) || 0,
      subscribed: Number(row.subscribed) || 0,
    })
  );

  const signups = weeks.reduce((sum, week) => sum + week.signups, 0);
  const setupStarted = weeks.reduce((sum, week) => sum + week.setupStarted, 0);
  const setupCompleted = weeks.reduce(
    (sum, week) => sum + week.setupCompleted,
    0
  );
  const activated = weeks.reduce((sum, week) => sum + week.activated, 0);
  const billingStarted = weeks.reduce(
    (sum, week) => sum + week.billingStarted,
    0
  );
  const subscribed = weeks.reduce((sum, week) => sum + week.subscribed, 0);

  return {
    days,
    weeks,
    totals: {
      signups,
      setupStarted,
      setupCompleted,
      activated,
      billingStarted,
      subscribed,
      setupStartRate: funnelRate(setupStarted, signups),
      setupCompletionRate: funnelRate(setupCompleted, signups),
      activationRate: funnelRate(activated, signups),
      billingStartRate: funnelRate(billingStarted, signups),
      conversionRate: funnelRate(subscribed, signups),
    },
  };
}
