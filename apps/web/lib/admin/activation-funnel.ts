import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";

/**
 * Canonical practice conversion funnel.
 *
 * - signup: a practice created inside the window (soft-deleted and explicitly
 *   analytics-excluded internal/test practices are excluded).
 * - activated: exact, repairable milestone projected from the first real
 *   client and first real appointment creation timestamps.
 * - first visit completed: a real appointment has a completed visit_closeout.
 *   This is the durable clinic-use signal because closeout constraints require
 *   finalized clinical handoff plus an attributable charge disposition.
 * - payment method collected: signed subscription Checkout completion created
 *   with payment_method_collection=always.
 * - first positive payment: signed subscription invoice.payment_succeeded with
 *   amount_paid > 0. Current subscription state is reported separately.
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
  firstVisitCompleted: number;
  paymentMethodCollected: number;
  firstPositivePayment: number;
  currentlyActive: number;
}

export interface ActivationFunnelDataQuality {
  confirmedUsSignups: number;
  confirmedNonUsSignups: number;
  unknownJurisdictionSignups: number;
  legacyBusinessStageRows: number;
  unknownPaymentMethodPractices: number;
  unknownPositivePaymentPractices: number;
  missingRegistrationMilestones: number;
  missingActivationMilestones: number;
  unprojectedStripeEvidence: number;
  unmappedStripeEvidence: number;
}

export interface ActivationFunnelTotals {
  signups: number;
  setupStarted: number;
  setupCompleted: number;
  activated: number;
  firstVisitCompleted: number;
  paymentMethodCollected: number;
  firstPositivePayment: number;
  currentlyActive: number;
  /** setupStarted / signups; 0 when there are no signups. */
  setupStartRate: number;
  /** setupCompleted / signups; 0 when there are no signups. */
  setupCompletionRate: number;
  /** activated / signups; 0 when there are no signups. */
  activationRate: number;
  /** firstVisitCompleted / activated; 0 when there are no activated clinics. */
  firstVisitCompletionRate: number;
  /** paymentMethodCollected / activated; 0 when there are no activations. */
  paymentMethodRate: number;
  /** firstPositivePayment / paymentMethodCollected. */
  positivePaymentRate: number;
  /** currently active subscription / signups; a current-state metric only. */
  currentlyActiveRate: number;
}

export type ActivationFunnelJurisdictionCohort =
  | "confirmedUs"
  | "confirmedNonUs"
  | "unknown";

export interface ActivationFunnel {
  days: number;
  weeks: ActivationFunnelWeek[];
  totals: ActivationFunnelTotals;
  jurisdictionCohorts: Record<
    ActivationFunnelJurisdictionCohort,
    ActivationFunnelTotals
  >;
  dataQuality: ActivationFunnelDataQuality;
}

/** Rate guarded against divide-by-zero: no signups means a 0 rate, not NaN. */
export function funnelRate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

interface FunnelRow {
  weekStart: string;
  jurisdictionCohort?: string;
  signups: number | string;
  setupStarted: number | string;
  setupCompleted: number | string;
  activated: number | string;
  firstVisitCompleted: number | string;
  paymentMethodCollected: number | string;
  firstPositivePayment: number | string;
  currentlyActive: number | string;
}

interface DataQualityRow {
  legacyBusinessStageRows: number | string;
  unknownPaymentMethodPractices: number | string;
  unknownPositivePaymentPractices: number | string;
  missingRegistrationMilestones: number | string;
  missingActivationMilestones: number | string;
  unprojectedStripeEvidence: number | string;
  unmappedStripeEvidence: number | string;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function emptyWeek(weekStart: string): ActivationFunnelWeek {
  return {
    weekStart,
    signups: 0,
    setupStarted: 0,
    setupCompleted: 0,
    activated: 0,
    firstVisitCompleted: 0,
    paymentMethodCollected: 0,
    firstPositivePayment: 0,
    currentlyActive: 0,
  };
}

function summarizeWeeks(weeks: ActivationFunnelWeek[]): ActivationFunnelTotals {
  const signups = weeks.reduce((sum, week) => sum + week.signups, 0);
  const setupStarted = weeks.reduce((sum, week) => sum + week.setupStarted, 0);
  const setupCompleted = weeks.reduce(
    (sum, week) => sum + week.setupCompleted,
    0,
  );
  const activated = weeks.reduce((sum, week) => sum + week.activated, 0);
  const firstVisitCompleted = weeks.reduce(
    (sum, week) => sum + week.firstVisitCompleted,
    0,
  );
  const paymentMethodCollected = weeks.reduce(
    (sum, week) => sum + week.paymentMethodCollected,
    0,
  );
  const firstPositivePayment = weeks.reduce(
    (sum, week) => sum + week.firstPositivePayment,
    0,
  );
  const currentlyActive = weeks.reduce(
    (sum, week) => sum + week.currentlyActive,
    0,
  );
  return {
    signups,
    setupStarted,
    setupCompleted,
    activated,
    firstVisitCompleted,
    paymentMethodCollected,
    firstPositivePayment,
    currentlyActive,
    setupStartRate: funnelRate(setupStarted, signups),
    setupCompletionRate: funnelRate(setupCompleted, signups),
    activationRate: funnelRate(activated, signups),
    firstVisitCompletionRate: funnelRate(firstVisitCompleted, activated),
    paymentMethodRate: funnelRate(paymentMethodCollected, activated),
    positivePaymentRate: funnelRate(
      firstPositivePayment,
      paymentMethodCollected,
    ),
    currentlyActiveRate: funnelRate(currentlyActive, signups),
  };
}

function jurisdictionCohort(
  value: string | undefined,
): ActivationFunnelJurisdictionCohort {
  if (value === "confirmedUs" || value === "confirmedNonUs") return value;
  return "unknown";
}

export async function computeActivationFunnel(
  db: Database,
  days: number
): Promise<ActivationFunnel> {
  const windowStart = new Date(Date.now() - days * DAY_MS).toISOString();

  // Cross-tenant read → system context (RLS bypass), same as the admin
  // overview. One grouped aggregate query — no per-practice N+1.
  const { cohortResult, qualityResult } = await withSystem(db, async (tx) => {
    const cohortResult = await tx.execute(sql`
      with signups as (
        select
          p.id,
          p.created_at,
          p.billing_status,
          p.settings,
          case
            when nullif(
              p.settings -> 'onboardingState' ->> 'jurisdictionSelectedAt',
              ''
            ) is not null
              and p.settings -> 'onboardingState' ->> 'jurisdictionCountry'
                = p.country
              and p.country = 'US'
              then 'confirmedUs'
            when nullif(
              p.settings -> 'onboardingState' ->> 'jurisdictionSelectedAt',
              ''
            ) is not null
              and p.settings -> 'onboardingState' ->> 'jurisdictionCountry'
                = p.country
              and p.country <> 'US'
              then 'confirmedNonUs'
            else 'unknown'
          end as jurisdiction_cohort,
          date_trunc('week', p.created_at) as week_start
        from practices p
        where p.deleted_at is null
          and p.created_at >= ${windowStart}::timestamptz
          and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      ), milestone_times as (
        select
          pcm.practice_id,
          min(pcm.occurred_at) filter (
            where pcm.milestone = 'registered'
          ) as registered_at,
          min(pcm.occurred_at) filter (
            where pcm.milestone = 'activated'
          ) as activated_at,
          min(pcm.occurred_at) filter (
            where pcm.milestone = 'payment_method_collected'
          ) as payment_method_at,
          min(pcm.occurred_at) filter (
            where pcm.milestone = 'first_positive_payment'
          ) as positive_payment_at
        from practice_conversion_milestones pcm
        join signups s on s.id = pcm.practice_id
        group by pcm.practice_id
      )
      select
        to_char(s.week_start, 'YYYY-MM-DD') as "weekStart",
        s.jurisdiction_cohort as "jurisdictionCohort",
        count(*) filter (where mt.registered_at is not null)::int as "signups",
        count(*) filter (
          where mt.registered_at is not null
            and (
              nullif(
                s.settings -> 'onboardingState' ->> 'onboardingIntentSelectedAt',
                ''
              ) is not null
              or nullif(s.settings -> 'onboardingState' ->> 'journeyStepId', '')
                is not null
              or nullif(s.settings ->> 'onboardingCompletedAt', '') is not null
            )
        )::int as "setupStarted",
        count(*) filter (
          where mt.registered_at is not null
            and nullif(s.settings ->> 'onboardingCompletedAt', '') is not null
        )::int as "setupCompleted",
        count(*) filter (
          where mt.registered_at is not null and mt.activated_at is not null
        )::int as "activated",
        count(*) filter (
          where mt.registered_at is not null
            and mt.activated_at is not null
            and exists (
            select 1
            from visit_closeouts vc
            join appointments a
              on a.id = vc.appointment_id
             and a.practice_id = s.id
             and a.deleted_at is null
            where vc.practice_id = s.id
              and vc.status = 'completed'
              and vc.deleted_at is null
              and a.created_at >= s.created_at
              and not (
                coalesce(s.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
                  @> to_jsonb(a.id::text)
              )
          )
        )::int as "firstVisitCompleted",
        count(*) filter (
          where mt.registered_at is not null
            and mt.activated_at is not null
            and mt.payment_method_at is not null
        )::int as "paymentMethodCollected",
        count(*) filter (
          where mt.registered_at is not null
            and mt.activated_at is not null
            and mt.payment_method_at is not null
            and mt.positive_payment_at is not null
        )::int as "firstPositivePayment",
        count(*) filter (
          where mt.registered_at is not null and s.billing_status = 'active'
        )::int as "currentlyActive"
      from signups s
      left join milestone_times mt on mt.practice_id = s.id
      group by s.week_start, s.jurisdiction_cohort
      order by s.week_start, s.jurisdiction_cohort
    `);

    const qualityResult = await tx.execute(sql`
      with cohort as (
        select p.*
        from practices p
        where p.deleted_at is null
          and p.created_at >= ${windowStart}::timestamptz
          and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      ), source_activation as (
        select p.id
        from cohort p
        where exists (
          select 1 from clients c
          where c.practice_id = p.id
            and not (
              coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb)
                @> to_jsonb(c.id::text)
            )
        ) and exists (
          select 1 from appointments a
          where a.practice_id = p.id
            and not (
              coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
                @> to_jsonb(a.id::text)
            )
        )
      )
      select
        (
          select count(*) from funnel_events fe
          join cohort p on p.id = fe.practice_id
          where fe.deleted_at is null
            and fe.event_name in ('registration', 'activation', 'card_added', 'paid')
        )::int as "legacyBusinessStageRows",
        (
          select count(*) from cohort p
          where (
            p.stripe_subscription_id is not null or exists (
              select 1 from funnel_events fe
              where fe.practice_id = p.id and fe.deleted_at is null
                and fe.event_name = 'card_added'
            )
          ) and not exists (
            select 1 from practice_conversion_milestones pcm
            where pcm.practice_id = p.id
              and pcm.milestone = 'payment_method_collected'
          )
        )::int as "unknownPaymentMethodPractices",
        (
          select count(*) from cohort p
          where (
            p.billing_status = 'active' or exists (
              select 1 from funnel_events fe
              where fe.practice_id = p.id and fe.deleted_at is null
                and fe.event_name = 'paid'
            )
          ) and not exists (
            select 1 from practice_conversion_milestones pcm
            where pcm.practice_id = p.id
              and pcm.milestone = 'first_positive_payment'
          )
        )::int as "unknownPositivePaymentPractices",
        (
          select count(*) from cohort p
          where not exists (
            select 1 from practice_conversion_milestones pcm
            where pcm.practice_id = p.id and pcm.milestone = 'registered'
          )
        )::int as "missingRegistrationMilestones",
        (
          select count(*) from source_activation sa
          where not exists (
            select 1 from practice_conversion_milestones pcm
            where pcm.practice_id = sa.id and pcm.milestone = 'activated'
          )
        )::int as "missingActivationMilestones",
        (
          select count(*) from stripe_events se
          join cohort p on p.id = se.practice_id
          where se.endpoint = 'subscription'
            and se.evidence_kind is not null
            and se.event_created_at is not null
            and not exists (
              select 1 from practice_conversion_milestones pcm
              where pcm.practice_id = se.practice_id
                and pcm.milestone = case se.evidence_kind
                  when 'subscription_checkout_completed'
                    then 'payment_method_collected'::practice_conversion_milestone
                  else 'first_positive_payment'::practice_conversion_milestone
                end
            )
        )::int as "unprojectedStripeEvidence",
        (
          select count(*) from stripe_events se
          where se.endpoint = 'subscription'
            and se.evidence_kind is not null
            and se.event_created_at >= ${windowStart}::timestamptz
            and se.practice_id is null
        )::int as "unmappedStripeEvidence"
    `);
    return { cohortResult, qualityResult };
  });

  const rawWeeks = rowsFromExecute<FunnelRow>(cohortResult).map((row) => ({
    ...emptyWeek(String(row.weekStart)),
    jurisdictionCohort: jurisdictionCohort(row.jurisdictionCohort),
    signups: Number(row.signups) || 0,
    setupStarted: Number(row.setupStarted) || 0,
    setupCompleted: Number(row.setupCompleted) || 0,
    activated: Number(row.activated) || 0,
    firstVisitCompleted: Number(row.firstVisitCompleted) || 0,
    paymentMethodCollected: Number(row.paymentMethodCollected) || 0,
    firstPositivePayment: Number(row.firstPositivePayment) || 0,
    currentlyActive: Number(row.currentlyActive) || 0,
  }));
  const weekly = new Map<string, ActivationFunnelWeek>();
  for (const row of rawWeeks) {
    const aggregate = weekly.get(row.weekStart) ?? emptyWeek(row.weekStart);
    for (const key of [
      "signups",
      "setupStarted",
      "setupCompleted",
      "activated",
      "firstVisitCompleted",
      "paymentMethodCollected",
      "firstPositivePayment",
      "currentlyActive",
    ] as const) {
      aggregate[key] += row[key];
    }
    weekly.set(row.weekStart, aggregate);
  }
  const weeks = [...weekly.values()].sort((left, right) =>
    left.weekStart.localeCompare(right.weekStart),
  );
  const cohortWeeks = (
    ["confirmedUs", "confirmedNonUs", "unknown"] as const
  ).map(
    (cohort) =>
      [
        cohort,
        rawWeeks
          .filter((week) => week.jurisdictionCohort === cohort)
          .map(({ jurisdictionCohort: _cohort, ...week }) => week),
      ] as const,
  );
  const quality = rowsFromExecute<DataQualityRow>(qualityResult)[0];
  const jurisdictionCohorts = Object.fromEntries(
    cohortWeeks.map(([cohort, rows]) => [cohort, summarizeWeeks(rows)]),
  ) as Record<ActivationFunnelJurisdictionCohort, ActivationFunnelTotals>;

  return {
    days,
    weeks,
    totals: summarizeWeeks(weeks),
    jurisdictionCohorts,
    dataQuality: {
      confirmedUsSignups: jurisdictionCohorts.confirmedUs.signups,
      confirmedNonUsSignups: jurisdictionCohorts.confirmedNonUs.signups,
      unknownJurisdictionSignups: jurisdictionCohorts.unknown.signups,
      legacyBusinessStageRows: Number(quality?.legacyBusinessStageRows) || 0,
      unknownPaymentMethodPractices:
        Number(quality?.unknownPaymentMethodPractices) || 0,
      unknownPositivePaymentPractices:
        Number(quality?.unknownPositivePaymentPractices) || 0,
      missingRegistrationMilestones:
        Number(quality?.missingRegistrationMilestones) || 0,
      missingActivationMilestones:
        Number(quality?.missingActivationMilestones) || 0,
      unprojectedStripeEvidence:
        Number(quality?.unprojectedStripeEvidence) || 0,
      unmappedStripeEvidence: Number(quality?.unmappedStripeEvidence) || 0,
    },
  };
}
