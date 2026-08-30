import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { funnelRate } from "@/lib/admin/activation-funnel";
import { safeAcquisitionReportingBucket } from "@/lib/acquisition";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ABANDONMENT_GRACE_DAYS = 7;
export const ACQUISITION_OUTCOME_ROW_LIMIT = 20;

export interface JourneyFunnelWeek {
  weekStart: string;
  visitors: number;
  demos: number;
  signupProfileViewed: number;
  signupProfileCompleted: number;
  signupAccountViewed: number;
  signupSubmitted: number;
  registrations: number;
  activated: number;
  paymentMethodCollected: number;
  firstPositivePayment: number;
}

export interface JourneyFunnelTotals {
  visitors: number;
  demos: number;
  signupProfileViewed: number;
  signupProfileCompleted: number;
  signupAccountViewed: number;
  signupSubmitted: number;
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
  historicalUnattributedRegistrations: number;
  repairableAttributionGaps: number;
  clientErrors: number;
  demoRate: number;
  profileViewRate: number;
  profileCompletionRate: number;
  accountViewRate: number;
  signupSubmitRate: number;
  signupSuccessRate: number;
  registrationRate: number;
  activationRate: number;
  paymentMethodRate: number;
  positivePaymentRate: number;
}

export interface AcquisitionOutcome {
  source: string;
  medium: string;
  campaign: string;
  registrations: number;
  activated: number;
  paymentMethodCollected: number;
  firstPositivePayment: number;
  activationRate: number;
  paymentMethodRate: number;
  positivePaymentRate: number;
}

export interface JourneyFunnelPeriodActivity {
  registrations: number;
  activated: number;
  paymentMethodCollected: number;
  firstPositivePayment: number;
}

export interface JourneyFunnel {
  days: number;
  weeks: JourneyFunnelWeek[];
  acquisitionOutcomes: AcquisitionOutcome[];
  acquisitionOutcomeRowLimit: number;
  acquisitionOutcomesTruncated: boolean;
  periodActivity: JourneyFunnelPeriodActivity;
  totals: JourneyFunnelTotals;
}

interface JourneyRow {
  weekStart: string;
  visitors: number | string;
  demos: number | string;
  signupProfileViewed: number | string;
  signupProfileCompleted: number | string;
  signupAccountViewed: number | string;
  signupSubmitted: number | string;
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

interface AcquisitionOutcomeRow {
  source: string;
  medium: string;
  campaign: string;
  registrations: number | string;
  activated: number | string;
  paymentMethodCollected: number | string;
  firstPositivePayment: number | string;
}

interface PeriodActivityRow {
  registrations: number | string;
  activated: number | string;
  paymentMethodCollected: number | string;
  firstPositivePayment: number | string;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function computeJourneyFunnel(
  db: Database,
  days: number,
  now: Date = new Date(),
): Promise<JourneyFunnel> {
  const windowStart = new Date(now.getTime() - days * DAY_MS).toISOString();
  const abandonedBefore = new Date(
    now.getTime() - ABANDONMENT_GRACE_DAYS * DAY_MS,
  ).toISOString();

  const {
    weeklyResult,
    unattributedResult,
    errorsResult,
    acquisitionResult,
    periodActivityResult,
  } = await withSystem(db, async (tx) => {
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
      ), signup_event_times as (
        select
          ft.anonymous_id,
          min(fe.created_at) filter (
            where fe.event_name = 'signup_profile_viewed'
          ) as signup_profile_viewed_at,
          min(fe.created_at) filter (
            where fe.event_name = 'signup_profile_completed'
          ) as signup_profile_completed_at,
          min(fe.created_at) filter (
            where fe.event_name = 'signup_account_viewed'
          ) as signup_account_viewed_at,
          min(fe.created_at) filter (
            where fe.event_name = 'signup_submitted'
          ) as signup_submitted_at
        from first_touch ft
        left join funnel_events fe
          on fe.anonymous_id = ft.anonymous_id
         and fe.deleted_at is null
         and fe.created_at >= ft.cohort_at
         and fe.event_name in (
           'signup_profile_viewed', 'signup_profile_completed',
           'signup_account_viewed', 'signup_submitted'
         )
        group by ft.anonymous_id
      ), journeys as (
        select
          ft.anonymous_id,
          ft.cohort_at,
          date_trunc('week', ft.cohort_at) as week_start,
          signup.signup_profile_viewed_at,
          signup.signup_profile_completed_at,
          signup.signup_account_viewed_at,
          signup.signup_submitted_at,
          demo.demo_at,
          demo.demo_at is not null as tried_demo,
          registration.practice_id,
          registration.registered_at
        from first_touch ft
        left join signup_event_times signup
          on signup.anonymous_id = ft.anonymous_id
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
        count(*) filter (
          where s.signup_profile_viewed_at is not null
        )::int as "signupProfileViewed",
        count(*) filter (
          where s.signup_profile_completed_at is not null
        )::int as "signupProfileCompleted",
        count(*) filter (
          where s.signup_account_viewed_at is not null
        )::int as "signupAccountViewed",
        count(*) filter (
          where s.signup_submitted_at is not null
        )::int as "signupSubmitted",
        count(*) filter (where s.practice_id is not null)::int as "registrations",
        count(*) filter (where s.activation_at is not null)::int as "activated",
        count(*) filter (
          where s.payment_method_at is not null
        )::int as "paymentMethodCollected",
        count(*) filter (
          where s.positive_payment_at is not null
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
      select
        count(*) filter (
          where not (
            coalesce(p.settings -> 'acquisition' ->> 'funnelId', '')
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          )
        )::int as "historicalUnknown",
        count(*) filter (
          where coalesce(p.settings -> 'acquisition' ->> 'funnelId', '')
              ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            and not exists (
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
        )::int as "repairableGap"
      from practices p
      where p.created_at >= ${windowStart}::timestamptz
        and p.deleted_at is null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
    `);
    const errorsResult = await tx.execute(sql`
      select count(*)::int as count
      from funnel_events
      where event_name = 'client_error'
        and deleted_at is null
        and created_at >= ${windowStart}::timestamptz
    `);

    // These are signup cohorts: the registration timestamp selects the
    // cohort, while all later canonical milestones become its outcomes.
    // Bucketing occurs before grouping so neither raw tokens nor a long tail
    // of one-off values can escape through the result cardinality.
    const acquisitionResult = await tx.execute(sql`
      with raw_signup_cohort as (
        select
          p.id as practice_id,
          lower(btrim(coalesce(
            p.settings -> 'acquisition' ->> 'source', ''
          ))) as raw_source,
          lower(btrim(coalesce(
            p.settings -> 'acquisition' ->> 'medium', ''
          ))) as raw_medium,
          lower(btrim(coalesce(
            p.settings -> 'acquisition' ->> 'campaign', ''
          ))) as raw_campaign
        from practice_conversion_milestones registered
        join practices p on p.id = registered.practice_id
        where registered.milestone = 'registered'
          and registered.occurred_at >= ${windowStart}::timestamptz
          and p.deleted_at is null
          and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      ), signup_cohort as (
        select
          practice_id,
          case
            when raw_source = ''
              or raw_source !~ '^[a-z0-9._:/-]{1,80}$'
              then 'Unknown'
            when raw_source in (
              'homepage_hero', 'homepage_start_small',
              'homepage_pricing', 'homepage_closing', 'homepage_demo'
            ) then 'homepage'
            when raw_source in (
              'nav', 'mobile_nav', 'resources_nav', 'footer'
            ) then 'navigation'
            when raw_source ~ '^cloud_(hero|founding_offer|closing)(_fit)?$'
              then 'cloud'
            when raw_source ~ '^feature_(schedule|records|billing|patients|communications|inventory|whiteboard|compliance|reports)_(hero|fit|hosting|hosting_fit|closing)$'
              then 'feature'
            when raw_source ~ '^solution_(general-practice|specialty-referral|emergency-critical-care|equine|mobile-house-call|multi-location|shelter-nonprofit|exotics-avian)_(hero|hosting|hosting_fit|closing)$'
              or raw_source in (
                'solutions_index_hosting', 'solutions_index_hosting_fit',
                'solutions_index_closing'
              )
              then 'solution'
            when raw_source ~ '^role_(practice-owners|practice-managers|veterinarians|veterinary-technicians|front-desk)_(hero|fit|hosting|hosting_fit|closing)$'
              then 'role'
            when raw_source ~ '^(compare|comparison)_openvpm-vs-(cornerstone|avimark|ezyvet|shepherd|provet-cloud|digitail|vetspire|idexx-neo|daysmart-vet|hippo-manager|navetor|impromed|openvpms)_(hero|fit|hosting|hosting_fit|closing)$'
              or raw_source in (
                'compare_index_hosting', 'compare_index_hosting_fit'
              )
              then 'comparison'
            when raw_source = 'blog'
              or raw_source ~ '^glossary_(pims|soap-notes|emr-vs-pims|controlled-substance-log|audit-trail|open-api|rest-api|webhook|vendor-lock-in|data-portability|open-source-veterinary-software|agplv3|self-hosting|managed-hosting|cloud-vs-on-premise|two-way-texting|appointment-reminder)_closing$'
              then 'content'
            when raw_source in ('install_demo', 'install_cloud')
              then 'install'
            when raw_source in (
              'second_pims_hosting', 'second_pims_hosting_fit',
              'second_pims_closing'
            ) then 'second_pims'
            when raw_source = 'why_closing' then 'why'
            when raw_source = 'demo' then 'demo'
            when raw_source = 'clinic_fit' then 'clinic_fit'
            when raw_source = 'marketing' then 'marketing'
            when raw_source = 'direct' then 'direct'
            else 'Other'
          end as source,
          case
            when raw_medium = ''
              or raw_medium !~ '^[a-z0-9._:/-]{1,80}$'
              then 'Unknown'
            when raw_medium = 'product' then 'product'
            when raw_medium = 'organic' then 'organic'
            when raw_medium = 'cpc' then 'cpc'
            when raw_medium in ('paid/social', 'paid_social')
              then 'paid_social'
            when raw_medium = 'email' then 'email'
            when raw_medium = 'referral' then 'referral'
            when raw_medium = 'direct' then 'direct'
            else 'Other'
          end as medium,
          case
            when raw_campaign = ''
              or raw_campaign !~ '^[a-z0-9._:/-]{1,80}$'
              then 'Unknown'
            when raw_campaign in (
              'demo_login', 'demo_dashboard', 'demo_ask_ai',
              'demo_day_board', 'demo_whiteboard', 'demo_client_portal',
              'demo_patients', 'demo_clients', 'demo_records',
              'demo_billing', 'demo_inbox', 'demo_inventory',
              'demo_reports', 'demo_settings', 'demo_other', 'demo_cta'
            ) then raw_campaign
            when raw_campaign in ('launch', 'clinic_launch-2026')
              then 'launch'
            when raw_campaign = 'direct' then 'direct'
            else 'Other'
          end as campaign
        from raw_signup_cohort
      ), outcomes as (
        select
          cohort.*,
          exists (
            select 1
            from practice_conversion_milestones activated
            where activated.practice_id = cohort.practice_id
              and activated.milestone = 'activated'
          ) as activated,
          exists (
            select 1
            from practice_conversion_milestones payment_method
            where payment_method.practice_id = cohort.practice_id
              and payment_method.milestone = 'payment_method_collected'
          ) as payment_method_collected,
          exists (
            select 1
            from practice_conversion_milestones positive_payment
            where positive_payment.practice_id = cohort.practice_id
              and positive_payment.milestone = 'first_positive_payment'
          ) as first_positive_payment
        from signup_cohort cohort
      )
      select
        source,
        medium,
        campaign,
        count(*)::int as registrations,
        count(*) filter (where activated)::int as activated,
        count(*) filter (
          where payment_method_collected
        )::int as "paymentMethodCollected",
        count(*) filter (
          where first_positive_payment
        )::int as "firstPositivePayment"
      from outcomes
      group by source, medium, campaign
      order by registrations desc, source, medium, campaign
      limit ${ACQUISITION_OUTCOME_ROW_LIMIT + 1}
    `);

    // This is intentionally not a registration cohort. It answers how many
    // canonical events occurred in the period, including later outcomes for
    // practices registered before it began.
    const periodActivityResult = await tx.execute(sql`
      select
        count(*) filter (
          where pcm.milestone = 'registered'
        )::int as registrations,
        count(*) filter (
          where pcm.milestone = 'activated'
        )::int as activated,
        count(*) filter (
          where pcm.milestone = 'payment_method_collected'
        )::int as "paymentMethodCollected",
        count(*) filter (
          where pcm.milestone = 'first_positive_payment'
        )::int as "firstPositivePayment"
      from practice_conversion_milestones pcm
      join practices p on p.id = pcm.practice_id
      where pcm.occurred_at >= ${windowStart}::timestamptz
        and p.deleted_at is null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
    `);

    return {
      weeklyResult,
      unattributedResult,
      errorsResult,
      acquisitionResult,
      periodActivityResult,
    };
  });

  const rawWeeks = rowsFromExecute<JourneyRow>(weeklyResult);
  const weeks = rawWeeks.map((row) => ({
    weekStart: String(row.weekStart),
    visitors: Number(row.visitors) || 0,
    demos: Number(row.demos) || 0,
    signupProfileViewed: Number(row.signupProfileViewed) || 0,
    signupProfileCompleted: Number(row.signupProfileCompleted) || 0,
    signupAccountViewed: Number(row.signupAccountViewed) || 0,
    signupSubmitted: Number(row.signupSubmitted) || 0,
    registrations: Number(row.registrations) || 0,
    activated: Number(row.activated) || 0,
    paymentMethodCollected: Number(row.paymentMethodCollected) || 0,
    firstPositivePayment: Number(row.firstPositivePayment) || 0,
  }));

  const sum = (key: keyof Omit<JourneyRow, "weekStart">) =>
    rawWeeks.reduce((total, week) => total + (Number(week[key]) || 0), 0);
  const visitors = sum("visitors");
  const demos = sum("demos");
  const signupProfileViewed = sum("signupProfileViewed");
  const signupProfileCompleted = sum("signupProfileCompleted");
  const signupAccountViewed = sum("signupAccountViewed");
  const signupSubmitted = sum("signupSubmitted");
  const registrations = sum("registrations");
  const activated = sum("activated");
  const paymentMethodCollected = sum("paymentMethodCollected");
  const firstPositivePayment = sum("firstPositivePayment");
  const unattributedRows = rowsFromExecute<{
    historicalUnknown: number | string;
    repairableGap: number | string;
  }>(unattributedResult);
  const historicalUnattributedRegistrations =
    Number(unattributedRows[0]?.historicalUnknown) || 0;
  const repairableAttributionGaps =
    Number(unattributedRows[0]?.repairableGap) || 0;
  const errorRows = rowsFromExecute<{ count: number | string }>(errorsResult);
  const rawAcquisitionOutcomes =
    rowsFromExecute<AcquisitionOutcomeRow>(acquisitionResult);
  const acquisitionOutcomesTruncated =
    rawAcquisitionOutcomes.length > ACQUISITION_OUTCOME_ROW_LIMIT;
  const acquisitionOutcomes = rawAcquisitionOutcomes
    .slice(0, ACQUISITION_OUTCOME_ROW_LIMIT)
    .map((row) => {
      const registrations = Number(row.registrations) || 0;
      const activated = Number(row.activated) || 0;
      const paymentMethodCollected = Number(row.paymentMethodCollected) || 0;
      const firstPositivePayment = Number(row.firstPositivePayment) || 0;
      return {
        source: safeAcquisitionReportingBucket("source", row.source),
        medium: safeAcquisitionReportingBucket("medium", row.medium),
        campaign: safeAcquisitionReportingBucket("campaign", row.campaign),
        registrations,
        activated,
        paymentMethodCollected,
        firstPositivePayment,
        activationRate: funnelRate(activated, registrations),
        paymentMethodRate: funnelRate(paymentMethodCollected, registrations),
        positivePaymentRate: funnelRate(firstPositivePayment, registrations),
      };
    });
  const periodRow = rowsFromExecute<PeriodActivityRow>(periodActivityResult)[0];

  return {
    days,
    weeks,
    acquisitionOutcomes,
    acquisitionOutcomeRowLimit: ACQUISITION_OUTCOME_ROW_LIMIT,
    acquisitionOutcomesTruncated,
    periodActivity: {
      registrations: Number(periodRow?.registrations) || 0,
      activated: Number(periodRow?.activated) || 0,
      paymentMethodCollected: Number(periodRow?.paymentMethodCollected) || 0,
      firstPositivePayment: Number(periodRow?.firstPositivePayment) || 0,
    },
    totals: {
      visitors,
      demos,
      signupProfileViewed,
      signupProfileCompleted,
      signupAccountViewed,
      signupSubmitted,
      registrations,
      activated,
      paymentMethodCollected,
      firstPositivePayment,
      leftBeforeTrying: sum("leftBeforeTrying"),
      demoAbandoned: sum("demoAbandoned"),
      registrationAbandoned: sum("registrationAbandoned"),
      activationAbandoned: sum("activationAbandoned"),
      paymentAbandoned: sum("paymentAbandoned"),
      unattributedRegistrations:
        historicalUnattributedRegistrations + repairableAttributionGaps,
      historicalUnattributedRegistrations,
      repairableAttributionGaps,
      clientErrors: Number(errorRows[0]?.count) || 0,
      demoRate: funnelRate(demos, visitors),
      profileViewRate: funnelRate(signupProfileViewed, visitors),
      profileCompletionRate: funnelRate(
        signupProfileCompleted,
        signupProfileViewed,
      ),
      accountViewRate: funnelRate(signupAccountViewed, signupProfileCompleted),
      signupSubmitRate: funnelRate(signupSubmitted, signupAccountViewed),
      signupSuccessRate: funnelRate(registrations, signupSubmitted),
      registrationRate: funnelRate(registrations, visitors),
      activationRate: funnelRate(activated, registrations),
      paymentMethodRate: funnelRate(paymentMethodCollected, registrations),
      positivePaymentRate: funnelRate(
        firstPositivePayment,
        paymentMethodCollected,
      ),
    },
  };
}
