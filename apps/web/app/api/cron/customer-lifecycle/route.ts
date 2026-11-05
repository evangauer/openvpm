import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { billingEnforced } from "@/lib/billing/plans";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import {
  sendAdoptionEmail,
  sendNpsSurveyEmail,
  sendTeamInviteNudgeEmail,
  sendTrialWinbackEmail,
} from "@/lib/email";
import { sendOptionalPlatformEmail } from "@/lib/email-lifecycle";
import {
  ADOPTION_AFTER_DAYS,
  ADOPTION_DEDUPE_BASE,
  ADOPTION_MAX_AGE_DAYS,
  adoptionDedupeKey,
  adoptionGaps,
  customerLifecycleConfig,
  NPS_FIRST_AFTER_DAYS,
  NPS_INTERVAL_DAYS,
  npsCycleDue,
  npsDedupeKey,
  npsSurveyKey,
  TEAM_INVITE_AFTER_DAYS,
  TEAM_INVITE_DEDUPE_BASE,
  teamInviteDedupeKey,
  TRIAL_WINBACK_DEDUPE_BASE,
  TRIAL_WINBACK_MAX_AGE_DAYS,
  TRIAL_WINBACK_MAX_EMAILS,
  trialWinbackDedupeKey,
  trialWinbackStepDue,
  usageSummaryPhrase,
} from "@/lib/growth/customer-lifecycle";
import { practiceUsageByIds, type PracticeUsage } from "@/lib/growth/practice-usage";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RUN_LIMIT_PER_CAMPAIGN = 100;
/** Team nudges stop once a trial is old enough that it no longer helps. */
const TEAM_INVITE_MAX_AGE_DAYS = 21;

type Campaign = "teamInvite" | "trialWinback" | "adoption" | "nps";

interface Tally {
  candidates: number;
  sent: number;
  deduped: number;
  suppressed: number;
  failed: number;
  skipped: number;
}

function emptyTally(): Tally {
  return {
    candidates: 0,
    sent: 0,
    deduped: 0,
    suppressed: 0,
    failed: 0,
    skipped: 0,
  };
}

function record(
  tally: Tally,
  result: { sent: boolean; deduped: boolean; suppressed?: boolean },
) {
  if (result.sent) tally.sent++;
  else if (result.suppressed) tally.suppressed++;
  else if (result.deduped) tally.deduped++;
  else tally.failed++;
}

/** Hosted clinics a person at OpenVPM may write to about their account. */
const reachablePractice = sql`
  p.deleted_at is null
  and p.recovery_hold = false
  and p.settings ->> 'analyticsExcluded' is distinct from 'true'
`;

/** The earliest admin, optionally only one with a verified address. */
function earliestAdmin(verifiedOnly: boolean): SQL {
  return sql`
    join lateral (
      select u.email, u.name
      from users u
      where u.practice_id = p.id
        and u.role = 'admin'
        and u.deleted_at is null
        ${verifiedOnly ? sql`and u.email_verified_at is not null` : sql``}
      order by u.created_at, u.id
      limit 1
    ) admin on true
  `;
}

function milestoneAt(milestone: string): SQL {
  return sql`(
    select m.occurred_at from practice_conversion_milestones m
    where m.practice_id = p.id and m.milestone = ${milestone}
  )`;
}

function emailHistory(dedupeBase: string): SQL {
  return sql`
    left join lateral (
      select count(*)::int as email_count, max(c.created_at) as last_email_at
      from communications c
      where c.practice_id = p.id
        and c.deleted_at is null
        and c.dedupe_key like (${dedupeBase} || p.id::text || '%')
    ) history on true
  `;
}

async function eligible(tx: Database, practiceId: string, predicate: SQL) {
  const result = await tx.execute(sql`
    select 1 as eligible from practices p
    where p.id = ${practiceId}::uuid and ${predicate}
    limit 1
  `);
  return rowsFromExecute<{ eligible: number }>(result).length > 0;
}

async function usageFor(ids: string[]): Promise<Map<string, PracticeUsage>> {
  if (ids.length === 0) return new Map();
  return withSystem(db, (tx) => practiceUsageByIds(tx, ids));
}

// ---------------------------------------------------------------------------
// Team invite: a trialing or paying clinic that is real-active but alone.
// ---------------------------------------------------------------------------

function teamInviteEligible(rolloutAt: Date): SQL {
  return sql`
    ${reachablePractice}
    and p.billing_status in ('trialing', 'active')
    and ${milestoneAt("activated")} is not null
    and coalesce(${milestoneAt("payment_method_collected")}, p.created_at)
      between greatest(
        ${rolloutAt.toISOString()}::timestamptz,
        now() - (${TEAM_INVITE_MAX_AGE_DAYS} * interval '1 day')
      ) and now() - (${TEAM_INVITE_AFTER_DAYS} * interval '1 day')
    and (
      select count(*) from users u
      where u.practice_id = p.id and u.deleted_at is null
    ) = 1
  `;
}

async function runTeamInvite(rolloutAt: Date, tally: Tally) {
  const rows = rowsFromExecute<{
    practiceId: string;
    practiceName: string;
    adminEmail: string;
    adminName: string | null;
  }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`
        select p.id as "practiceId", p.name as "practiceName",
          admin.email as "adminEmail", admin.name as "adminName"
        from practices p
        ${earliestAdmin(true)}
        ${emailHistory(TEAM_INVITE_DEDUPE_BASE)}
        where ${teamInviteEligible(rolloutAt)}
          and coalesce(history.email_count, 0) = 0
        order by p.created_at, p.id
        limit ${RUN_LIMIT_PER_CAMPAIGN}
      `),
    ),
  );
  tally.candidates += rows.length;
  const usage = await usageFor(rows.map((r) => r.practiceId));

  for (const row of rows) {
    const dedupeKey = teamInviteDedupeKey(row.practiceId);
    record(
      tally,
      await sendOptionalPlatformEmail({
        practiceId: row.practiceId,
        to: row.adminEmail,
        emailType: "team-invite",
        dedupeKey,
        retryOnFail: true,
        stillEligible: (tx) =>
          eligible(tx, row.practiceId, teamInviteEligible(rolloutAt)),
        send: () =>
          sendTeamInviteNudgeEmail({
            to: row.adminEmail,
            practiceName: row.practiceName,
            adminName: row.adminName,
            appointments: usage.get(row.practiceId)?.appointments ?? 0,
            idempotencyKey: dedupeKey,
          }),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Trial win-back: the trial ended without billing.
// ---------------------------------------------------------------------------

function trialLapsed(rolloutAt: Date): SQL {
  return sql`
    ${reachablePractice}
    and p.trial_ends_at is not null
    and p.trial_ends_at >= ${rolloutAt.toISOString()}::timestamptz
    and p.trial_ends_at <= now()
    and p.trial_ends_at > now() - (${TRIAL_WINBACK_MAX_AGE_DAYS} * interval '1 day')
    and p.billing_status not in ('active', 'past_due')
    and coalesce(p.settings -> 'onboardingState' ->> 'onboardingIntent', '')
      <> 'self_host'
    and not (
      nullif(p.settings -> 'growthLead' ->> 'stopReasonAt', '') is not null
      and (p.settings -> 'growthLead' ->> 'stopReasonAt')::timestamptz
        >= p.trial_ends_at
    )
  `;
}

async function runTrialWinback(now: Date, rolloutAt: Date, tally: Tally) {
  const rows = rowsFromExecute<{
    practiceId: string;
    practiceName: string;
    trialEndsAt: Date | string;
    adminEmail: string;
    adminName: string | null;
    existingEmailCount: number | string;
    lastEmailAt: Date | string | null;
  }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`
        select p.id as "practiceId", p.name as "practiceName",
          p.trial_ends_at as "trialEndsAt",
          admin.email as "adminEmail", admin.name as "adminName",
          coalesce(history.email_count, 0)::int as "existingEmailCount",
          history.last_email_at as "lastEmailAt"
        from practices p
        ${earliestAdmin(false)}
        ${emailHistory(TRIAL_WINBACK_DEDUPE_BASE)}
        where ${trialLapsed(rolloutAt)}
          and coalesce(history.email_count, 0) < ${TRIAL_WINBACK_MAX_EMAILS}
        order by p.trial_ends_at, p.id
        limit ${RUN_LIMIT_PER_CAMPAIGN}
      `),
    ),
  );
  tally.candidates += rows.length;
  const due = rows
    .map((row) => ({
      row,
      step: trialWinbackStepDue({
        now,
        trialEndedAt: row.trialEndsAt,
        existingEmailCount: Number(row.existingEmailCount) || 0,
        lastEmailAt: row.lastEmailAt,
      }),
    }))
    .filter((entry) => {
      if (!entry.step) tally.skipped++;
      return entry.step !== null;
    });
  const usage = await usageFor(due.map((entry) => entry.row.practiceId));

  for (const { row, step } of due) {
    const dedupeKey = trialWinbackDedupeKey(row.practiceId, step!);
    const practiceUsage = usage.get(row.practiceId);
    record(
      tally,
      await sendOptionalPlatformEmail({
        practiceId: row.practiceId,
        to: row.adminEmail,
        emailType: "trial-winback",
        dedupeKey,
        retryOnFail: true,
        stillEligible: (tx) =>
          eligible(tx, row.practiceId, trialLapsed(rolloutAt)),
        send: () =>
          sendTrialWinbackEmail({
            to: row.adminEmail,
            practiceId: row.practiceId,
            practiceName: row.practiceName,
            adminName: row.adminName,
            step: step!,
            usageSummary: practiceUsage ? usageSummaryPhrase(practiceUsage) : null,
            idempotencyKey: dedupeKey,
          }),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Adoption: two weeks after the first payment, what is not turned on yet.
// ---------------------------------------------------------------------------

function payingSince(): SQL {
  return milestoneAt("first_positive_payment");
}

function adoptionEligible(rolloutAt: Date): SQL {
  return sql`
    ${reachablePractice}
    and p.billing_status = 'active'
    and ${payingSince()} >= ${rolloutAt.toISOString()}::timestamptz
    and ${payingSince()} <= now() - (${ADOPTION_AFTER_DAYS} * interval '1 day')
    and ${payingSince()} > now() - (${ADOPTION_MAX_AGE_DAYS} * interval '1 day')
  `;
}

async function runAdoption(rolloutAt: Date, tally: Tally) {
  const rows = rowsFromExecute<{
    practiceId: string;
    practiceName: string;
    adminEmail: string;
    adminName: string | null;
  }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`
        select p.id as "practiceId", p.name as "practiceName",
          admin.email as "adminEmail", admin.name as "adminName"
        from practices p
        ${earliestAdmin(true)}
        ${emailHistory(ADOPTION_DEDUPE_BASE)}
        where ${adoptionEligible(rolloutAt)}
          and coalesce(history.email_count, 0) = 0
        order by p.created_at, p.id
        limit ${RUN_LIMIT_PER_CAMPAIGN}
      `),
    ),
  );
  tally.candidates += rows.length;
  const usage = await usageFor(rows.map((r) => r.practiceId));

  for (const row of rows) {
    const practiceUsage = usage.get(row.practiceId);
    const gaps = practiceUsage ? adoptionGaps(practiceUsage) : [];
    if (gaps.length === 0) {
      // Nothing to suggest: a clinic using everything gets no email.
      tally.skipped++;
      continue;
    }
    const dedupeKey = adoptionDedupeKey(row.practiceId);
    record(
      tally,
      await sendOptionalPlatformEmail({
        practiceId: row.practiceId,
        to: row.adminEmail,
        emailType: "adoption",
        dedupeKey,
        retryOnFail: true,
        stillEligible: (tx) =>
          eligible(tx, row.practiceId, adoptionEligible(rolloutAt)),
        send: () =>
          sendAdoptionEmail({
            to: row.adminEmail,
            practiceName: row.practiceName,
            adminName: row.adminName,
            gaps,
            idempotencyKey: dedupeKey,
          }),
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// NPS: day 30 after the first payment, then every 90 days.
// ---------------------------------------------------------------------------

const npsEligible = sql`
  ${reachablePractice}
  and p.billing_status = 'active'
  and ${payingSince()} <= now() - (${NPS_FIRST_AFTER_DAYS} * interval '1 day')
`;

async function runNps(now: Date, rolloutAt: Date, tally: Tally) {
  const rows = rowsFromExecute<{
    practiceId: string;
    practiceName: string;
    payingSince: Date | string;
    adminEmail: string;
    adminName: string | null;
  }>(
    await withSystem(db, (tx) =>
      tx.execute(sql`
        select p.id as "practiceId", p.name as "practiceName",
          ${payingSince()} as "payingSince",
          admin.email as "adminEmail", admin.name as "adminName"
        from practices p
        ${earliestAdmin(true)}
        where ${npsEligible}
        order by p.id
        limit ${RUN_LIMIT_PER_CAMPAIGN * 5}
      `),
    ),
  );

  let attempted = 0;
  for (const row of rows) {
    const cycle = npsCycleDue({ now, payingSince: row.payingSince });
    if (cycle === null) continue;
    // Prospective: only cycles whose window opened after rollout, so turning
    // this on never surveys every existing customer at once.
    const windowOpenedAt =
      new Date(row.payingSince).getTime() +
      (NPS_FIRST_AFTER_DAYS + (cycle - 1) * NPS_INTERVAL_DAYS) * 86_400_000;
    if (windowOpenedAt < rolloutAt.getTime()) continue;
    if (attempted >= RUN_LIMIT_PER_CAMPAIGN) break;
    attempted++;
    tally.candidates++;

    const survey = npsSurveyKey(cycle);
    const dedupeKey = npsDedupeKey(row.practiceId, cycle);
    record(
      tally,
      await sendOptionalPlatformEmail({
        practiceId: row.practiceId,
        to: row.adminEmail,
        emailType: "nps",
        dedupeKey,
        retryOnFail: true,
        stillEligible: (tx) => eligible(tx, row.practiceId, npsEligible),
        send: () =>
          sendNpsSurveyEmail({
            to: row.adminEmail,
            practiceId: row.practiceId,
            practiceName: row.practiceName,
            adminName: row.adminName,
            survey,
            idempotencyKey: dedupeKey,
          }),
      }),
    );
  }
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const config = customerLifecycleConfig();
  const disabledReason = !billingEnforced()
    ? "billing_disabled"
    : !config.enabled
      ? config.reason
      : null;
  if (disabledReason || !config.enabled) {
    await reportCronHeartbeat({
      job: "customer-lifecycle",
      status: "ok",
      detail: `Campaign disabled: ${disabledReason}`,
      metrics: { sent: 0, reason: disabledReason ?? "disabled" },
    });
    return NextResponse.json({ disabled: true, reason: disabledReason, sent: 0 });
  }

  const now = new Date();
  const tallies: Record<Campaign, Tally> = {
    teamInvite: emptyTally(),
    trialWinback: emptyTally(),
    adoption: emptyTally(),
    nps: emptyTally(),
  };
  const errors: string[] = [];
  // Campaigns are independent: one failing query never blocks the others.
  const runs: Array<[Campaign, () => Promise<void>]> = [
    ["teamInvite", () => runTeamInvite(config.rolloutAt, tallies.teamInvite)],
    [
      "trialWinback",
      () => runTrialWinback(now, config.rolloutAt, tallies.trialWinback),
    ],
    ["adoption", () => runAdoption(config.rolloutAt, tallies.adoption)],
    ["nps", () => runNps(now, config.rolloutAt, tallies.nps)],
  ];
  for (const [campaign, run] of runs) {
    try {
      await run();
    } catch (error) {
      errors.push(
        `${campaign}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const totals = Object.values(tallies).reduce(
    (sum, t) => ({
      sent: sum.sent + t.sent,
      failed: sum.failed + t.failed,
    }),
    { sent: 0, failed: 0 },
  );
  if (errors.length > 0) {
    void alertOps("Customer lifecycle cron failed", errors.join("\n"));
  }
  await reportCronHeartbeat({
    job: "customer-lifecycle",
    status:
      errors.length === runs.length
        ? "failed"
        : errors.length > 0 || totals.failed > 0
          ? "degraded"
          : "ok",
    detail: `${totals.sent} sent, ${totals.failed} failed${errors.length ? `, ${errors.length} campaign error(s)` : ""}`,
    metrics: { ...totals, errors: errors.length },
  });
  return NextResponse.json(
    { ...tallies, errors: errors.length },
    { status: errors.length === runs.length ? 500 : 200 },
  );
}
