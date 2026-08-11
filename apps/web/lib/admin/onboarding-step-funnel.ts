import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ONBOARDING_STALL_DAYS = 7;

export interface OnboardingStepFunnelWeek {
  weekStart: string;
  signups: number;
  intentCompleted: number;
  basicsCompleted: number;
  dataCompleted: number;
  allSetCompleted: number;
  stalledBeforeIntent: number;
  stalledAtBasics: number;
  stalledAtData: number;
  stalledAtAllSet: number;
}

export interface OnboardingStepFunnelTotals extends Omit<
  OnboardingStepFunnelWeek,
  "weekStart"
> {
  intentCompletionRate: number;
  basicsCompletionRate: number;
  dataCompletionRate: number;
  allSetCompletionRate: number;
}

export interface OnboardingStepFunnelDataQuality {
  fullyInstrumentedPractices: number;
  partiallyInstrumentedPractices: number;
  historicalInferredPractices: number;
  noStepEvidencePractices: number;
}

export interface OnboardingStepFunnel {
  days: number;
  stallDays: number;
  weeks: OnboardingStepFunnelWeek[];
  totals: OnboardingStepFunnelTotals;
  dataQuality: OnboardingStepFunnelDataQuality;
}

interface FunnelRow {
  weekStart: string;
  signups: number | string;
  intentCompleted: number | string;
  basicsCompleted: number | string;
  dataCompleted: number | string;
  allSetCompleted: number | string;
  stalledBeforeIntent: number | string;
  stalledAtBasics: number | string;
  stalledAtData: number | string;
  stalledAtAllSet: number | string;
}

interface DataQualityRow {
  fullyInstrumentedPractices: number | string;
  partiallyInstrumentedPractices: number | string;
  historicalInferredPractices: number | string;
  noStepEvidencePractices: number | string;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function rate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function summarizeWeeks(
  weeks: OnboardingStepFunnelWeek[],
): OnboardingStepFunnelTotals {
  const summed = weeks.reduce<Omit<OnboardingStepFunnelWeek, "weekStart">>(
    (total, week) => ({
      signups: total.signups + week.signups,
      intentCompleted: total.intentCompleted + week.intentCompleted,
      basicsCompleted: total.basicsCompleted + week.basicsCompleted,
      dataCompleted: total.dataCompleted + week.dataCompleted,
      allSetCompleted: total.allSetCompleted + week.allSetCompleted,
      stalledBeforeIntent: total.stalledBeforeIntent + week.stalledBeforeIntent,
      stalledAtBasics: total.stalledAtBasics + week.stalledAtBasics,
      stalledAtData: total.stalledAtData + week.stalledAtData,
      stalledAtAllSet: total.stalledAtAllSet + week.stalledAtAllSet,
    }),
    {
      signups: 0,
      intentCompleted: 0,
      basicsCompleted: 0,
      dataCompleted: 0,
      allSetCompleted: 0,
      stalledBeforeIntent: 0,
      stalledAtBasics: 0,
      stalledAtData: 0,
      stalledAtAllSet: 0,
    },
  );
  return {
    ...summed,
    intentCompletionRate: rate(summed.intentCompleted, summed.signups),
    basicsCompletionRate: rate(summed.basicsCompleted, summed.intentCompleted),
    dataCompletionRate: rate(summed.dataCompleted, summed.basicsCompleted),
    allSetCompletionRate: rate(summed.allSetCompleted, summed.dataCompleted),
  };
}

/**
 * Signup-week cohorts for the four guided setup steps.
 *
 * New evidence is written as first-write-wins database timestamps. Historical
 * clinics may contribute inferred completion counts from their last durable
 * cursor, but never contribute fabricated timestamps to the seven-day stall
 * queues. The data-quality totals keep those two evidence classes explicit.
 */
export async function computeOnboardingStepFunnel(
  db: Database,
  days: number,
): Promise<OnboardingStepFunnel> {
  const windowStart = new Date(Date.now() - days * DAY_MS).toISOString();
  const stallCutoff = new Date(
    Date.now() - ONBOARDING_STALL_DAYS * DAY_MS,
  ).toISOString();

  const { cohortResult, qualityResult } = await withSystem(db, async (tx) => {
    const cohortResult = await tx.execute(sql`
      with cohort as (
        select
          p.id,
          p.created_at,
          p.settings,
          date_trunc('week', p.created_at at time zone 'UTC') as week_start,
          (
            p.settings -> 'onboardingState' ->> 'migrationHasCommittedChanges'
              = 'true'
            or exists (
              select 1
              from migration_runs mr
              where mr.practice_id = p.id
                and mr.status = 'committed'
                and mr.deleted_at is null
                and mr.imported_count + mr.reconciled_count > 0
            )
          ) as migration_committed,
          exists (
            select 1
            from practice_conversion_milestones pcm
            where pcm.practice_id = p.id
              and pcm.milestone = 'registered'
          ) as registered
        from practices p
        where p.deleted_at is null
          and p.created_at >= ${windowStart}::timestamptz
          and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      ), raw_evidence as (
        select
          c.*,
          nullif(c.settings -> 'onboardingState' ->> 'journeyStepId', '')
            as journey_step_raw,
          nullif(c.settings -> 'onboardingState' ->> 'onboardingIntent', '')
            as onboarding_intent_raw,
          nullif(c.settings ->> 'onboardingCompletedAt', '')
            as legacy_all_set_raw,
          nullif(
            c.settings -> 'onboardingState' ->> 'journeyIntentCompletedAt',
            ''
          ) as exact_intent_raw,
          nullif(
            c.settings -> 'onboardingState' ->> 'journeyBasicsCompletedAt',
            ''
          ) as exact_basics_raw,
          nullif(
            c.settings -> 'onboardingState' ->> 'journeyDataCompletedAt',
            ''
          ) as exact_data_raw,
          nullif(
            c.settings -> 'onboardingState' ->> 'journeyAllSetCompletedAt',
            ''
          ) as exact_all_set_raw,
          nullif(
            c.settings -> 'onboardingState' ->> 'onboardingIntentSelectedAt',
            ''
          ) as legacy_intent_raw
        from cohort c
        where c.registered
      ), cursor_evidence as (
        select
          r.*,
          case
            when r.onboarding_intent_raw in (
              'alongside', 'replace', 'explore', 'self_host'
            )
              and r.journey_step_raw in ('intent', 'basics', 'data', 'allSet')
              then r.journey_step_raw
            when r.onboarding_intent_raw in (
              'alongside', 'replace', 'explore', 'self_host'
            )
              and r.journey_step_raw in (
              'branding', 'team', 'agent', 'phone', 'billing'
            )
              then case when r.migration_committed then 'allSet' else 'data' end
          end as journey_step
        from raw_evidence r
      ), bounded_evidence as (
        select
          r.*,
          (
            r.exact_intent_raw is not null
            or r.exact_basics_raw is not null
            or r.exact_data_raw is not null
            or r.exact_all_set_raw is not null
          ) as has_exact_raw,
          case
            when pg_input_is_valid(r.exact_intent_raw, 'timestamptz')
              then case
                when r.exact_intent_raw::timestamptz
                  between r.created_at and statement_timestamp()
                  then r.exact_intent_raw::timestamptz
              end
          end as exact_intent_at,
          case
            when pg_input_is_valid(r.exact_basics_raw, 'timestamptz')
              then case
                when r.exact_basics_raw::timestamptz
                  between r.created_at and statement_timestamp()
                  then r.exact_basics_raw::timestamptz
              end
          end as bounded_basics_at,
          case
            when pg_input_is_valid(r.exact_data_raw, 'timestamptz')
              then case
                when r.exact_data_raw::timestamptz
                  between r.created_at and statement_timestamp()
                  then r.exact_data_raw::timestamptz
              end
          end as bounded_data_at,
          case
            when pg_input_is_valid(r.exact_all_set_raw, 'timestamptz')
              then case
                when r.exact_all_set_raw::timestamptz
                  between r.created_at and statement_timestamp()
                  then r.exact_all_set_raw::timestamptz
              end
          end as bounded_all_set_at,
          case
            when pg_input_is_valid(r.legacy_intent_raw, 'timestamptz')
              then case
                when r.legacy_intent_raw::timestamptz
                  between r.created_at and statement_timestamp()
                  then r.legacy_intent_raw::timestamptz
              end
          end as legacy_intent_at,
          case
            when pg_input_is_valid(r.legacy_all_set_raw, 'timestamptz')
              then case
                when r.legacy_all_set_raw::timestamptz
                  between r.created_at and statement_timestamp()
                  then r.legacy_all_set_raw::timestamptz
              end
          end as legacy_all_set_at
        from cursor_evidence r
      ), ordered_basics as (
        select
          b.*,
          case
            when b.exact_intent_at is not null
              and b.bounded_basics_at >= b.exact_intent_at
              then b.bounded_basics_at
          end as exact_basics_at
        from bounded_evidence b
      ), ordered_data as (
        select
          b.*,
          case
            when b.exact_basics_at is not null
              and b.bounded_data_at >= b.exact_basics_at
              then b.bounded_data_at
          end as exact_data_at
        from ordered_basics b
      ), ordered_all_set as (
        select
          d.*,
          case
            when d.exact_data_at is not null
              and d.bounded_all_set_at >= d.exact_data_at
              then d.bounded_all_set_at
          end as exact_all_set_at
        from ordered_data d
      ), stage_evidence as (
        select
          e.*,
          coalesce((
            e.exact_intent_at is not null
            or e.legacy_intent_at is not null
            or e.journey_step in ('basics', 'data', 'allSet')
            or e.legacy_all_set_at is not null
          ), false) as intent_done,
          coalesce((
            e.exact_basics_at is not null
            or e.journey_step in ('data', 'allSet')
            or e.legacy_all_set_at is not null
          ), false) as basics_done,
          coalesce((
            e.exact_data_at is not null
            or e.journey_step = 'allSet'
            or e.legacy_all_set_at is not null
          ), false) as data_done,
          (
            e.exact_all_set_at is not null
            or e.legacy_all_set_at is not null
          ) as all_set_done
        from ordered_all_set e
      )
      select
        to_char(s.week_start, 'YYYY-MM-DD') as "weekStart",
        count(*)::int as "signups",
        count(*) filter (where s.intent_done)::int as "intentCompleted",
        count(*) filter (
          where s.intent_done and s.basics_done
        )::int as "basicsCompleted",
        count(*) filter (
          where s.intent_done and s.basics_done and s.data_done
        )::int as "dataCompleted",
        count(*) filter (
          where s.intent_done and s.basics_done and s.data_done
            and s.all_set_done
        )::int as "allSetCompleted",
        count(*) filter (
          where s.created_at <= ${stallCutoff}::timestamptz
            and not s.intent_done
        )::int as "stalledBeforeIntent",
        count(*) filter (
          where s.exact_intent_at is not null
            and s.exact_intent_at <= ${stallCutoff}::timestamptz
            and not s.basics_done
        )::int as "stalledAtBasics",
        count(*) filter (
          where s.exact_basics_at is not null
            and s.exact_basics_at <= ${stallCutoff}::timestamptz
            and not s.data_done
        )::int as "stalledAtData",
        count(*) filter (
          where s.exact_data_at is not null
            and s.exact_data_at <= ${stallCutoff}::timestamptz
            and not s.all_set_done
        )::int as "stalledAtAllSet"
      from stage_evidence s
      group by s.week_start
      order by s.week_start
    `);

    const qualityResult = await tx.execute(sql`
      with cohort as (
        select p.created_at, p.settings
        from practices p
        where p.deleted_at is null
          and p.created_at >= ${windowStart}::timestamptz
          and p.settings ->> 'analyticsExcluded' is distinct from 'true'
          and exists (
            select 1
            from practice_conversion_milestones pcm
            where pcm.practice_id = p.id
              and pcm.milestone = 'registered'
          )
      ), raw_evidence as (
        select
          created_at,
          nullif(
            settings -> 'onboardingState' ->> 'journeyIntentCompletedAt',
            ''
          ) as exact_intent_raw,
          nullif(
            settings -> 'onboardingState' ->> 'journeyBasicsCompletedAt',
            ''
          ) as exact_basics_raw,
          nullif(
            settings -> 'onboardingState' ->> 'journeyDataCompletedAt',
            ''
          ) as exact_data_raw,
          nullif(
            settings -> 'onboardingState' ->> 'journeyAllSetCompletedAt',
            ''
          ) as exact_all_set_raw,
          nullif(
            settings -> 'onboardingState' ->> 'onboardingIntentSelectedAt',
            ''
          ) as legacy_intent_raw,
          nullif(settings ->> 'onboardingCompletedAt', '')
            as legacy_all_set_raw,
          nullif(settings -> 'onboardingState' ->> 'journeyStepId', '')
            as journey_step,
          nullif(settings -> 'onboardingState' ->> 'onboardingIntent', '')
            as onboarding_intent
        from cohort
      ), evidence as (
        select
          (
            exact_intent_raw is not null
            or exact_basics_raw is not null
            or exact_data_raw is not null
            or exact_all_set_raw is not null
          ) as has_exact_raw,
          case
            when pg_input_is_valid(exact_intent_raw, 'timestamptz')
              and pg_input_is_valid(exact_basics_raw, 'timestamptz')
              and pg_input_is_valid(exact_data_raw, 'timestamptz')
              and pg_input_is_valid(exact_all_set_raw, 'timestamptz')
              then (
                exact_intent_raw::timestamptz
                  between created_at and statement_timestamp()
                and exact_basics_raw::timestamptz
                  between exact_intent_raw::timestamptz and statement_timestamp()
                and exact_data_raw::timestamptz
                  between exact_basics_raw::timestamptz and statement_timestamp()
                and exact_all_set_raw::timestamptz
                  between exact_data_raw::timestamptz and statement_timestamp()
              )
            else false
          end as fully_instrumented,
          coalesce((
            (
              onboarding_intent in (
                'alongside', 'replace', 'explore', 'self_host'
              )
              and journey_step in (
                'intent', 'basics', 'data', 'allSet',
                'branding', 'team', 'agent', 'phone', 'billing'
              )
            )
            or case
              when pg_input_is_valid(legacy_intent_raw, 'timestamptz')
                then legacy_intent_raw::timestamptz
                  between created_at and statement_timestamp()
              else false
            end
            or case
              when pg_input_is_valid(legacy_all_set_raw, 'timestamptz')
                then legacy_all_set_raw::timestamptz
                  between created_at and statement_timestamp()
              else false
            end
          ), false) as legacy_evidence
        from raw_evidence
      )
      select
        count(*) filter (
          where fully_instrumented
        )::int as "fullyInstrumentedPractices",
        count(*) filter (
          where has_exact_raw and not fully_instrumented
        )::int as "partiallyInstrumentedPractices",
        count(*) filter (
          where not has_exact_raw and legacy_evidence
        )::int as "historicalInferredPractices",
        count(*) filter (
          where not has_exact_raw and not legacy_evidence
        )::int as "noStepEvidencePractices"
      from evidence
    `);

    return { cohortResult, qualityResult };
  });

  const weeks = rowsFromExecute<FunnelRow>(cohortResult).map((row) => ({
    weekStart: row.weekStart,
    signups: Number(row.signups) || 0,
    intentCompleted: Number(row.intentCompleted) || 0,
    basicsCompleted: Number(row.basicsCompleted) || 0,
    dataCompleted: Number(row.dataCompleted) || 0,
    allSetCompleted: Number(row.allSetCompleted) || 0,
    stalledBeforeIntent: Number(row.stalledBeforeIntent) || 0,
    stalledAtBasics: Number(row.stalledAtBasics) || 0,
    stalledAtData: Number(row.stalledAtData) || 0,
    stalledAtAllSet: Number(row.stalledAtAllSet) || 0,
  }));
  const quality = rowsFromExecute<DataQualityRow>(qualityResult)[0];

  return {
    days,
    stallDays: ONBOARDING_STALL_DAYS,
    weeks,
    totals: summarizeWeeks(weeks),
    dataQuality: {
      fullyInstrumentedPractices:
        Number(quality?.fullyInstrumentedPractices) || 0,
      partiallyInstrumentedPractices:
        Number(quality?.partiallyInstrumentedPractices) || 0,
      historicalInferredPractices:
        Number(quality?.historicalInferredPractices) || 0,
      noStepEvidencePractices: Number(quality?.noStepEvidencePractices) || 0,
    },
  };
}
