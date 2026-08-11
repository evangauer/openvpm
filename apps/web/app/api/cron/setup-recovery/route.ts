import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { billingEnforced } from "@/lib/billing/plans";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { sendSetupRecoveryEmail } from "@/lib/email";
import { sendOptionalPlatformEmail } from "@/lib/email-lifecycle";
import {
  setupRecoveryAttempt,
  setupRecoveryCopy,
  setupRecoveryDedupeKey,
  setupRecoveryState,
} from "@/lib/onboarding/setup-recovery";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SETUP_RECOVERY_RUN_LIMIT = 100;

interface CandidateRow {
  practiceId: string;
  practiceName: string;
  billingStatus: string;
  trialEndsAt: Date | string | null;
  createdAt: Date | string;
  settings: unknown;
  adminEmail: string;
  activated: boolean;
  existingEmailCount: number | string;
  lastEmailAt: Date | string | null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

async function setupRecoveryCandidates(): Promise<CandidateRow[]> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      select
        p.id as "practiceId",
        p.name as "practiceName",
        p.billing_status as "billingStatus",
        p.trial_ends_at as "trialEndsAt",
        p.created_at as "createdAt",
        p.settings,
        admin.email as "adminEmail",
        exists (
          select 1
          from practice_conversion_milestones pcm
          where pcm.practice_id = p.id
            and pcm.milestone = 'activated'
        ) as activated,
        coalesce(email_history.email_count, 0)::int as "existingEmailCount",
        email_history.last_email_at as "lastEmailAt"
      from practices p
      join lateral (
        select u.email
        from users u
        where u.practice_id = p.id
          and u.role = 'admin'
          and u.email_verified_at is not null
          and u.deleted_at is null
        order by u.created_at, u.id
        limit 1
      ) admin on true
      left join lateral (
        select
          count(*)::int as email_count,
          max(c.created_at) as last_email_at
        from communications c
        where c.practice_id = p.id
          and c.deleted_at is null
          and c.dedupe_key like
            ('lc:setup-recovery:v1:' || p.id::text || ':%')
      ) email_history on true
      where p.deleted_at is null
        and p.recovery_hold = false
        and p.billing_status = 'trialing'
        and p.trial_ends_at > now() + interval '48 hours'
        and p.created_at <= now() - interval '24 hours'
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
        and nullif(p.settings ->> 'onboardingCompletedAt', '') is null
        and coalesce(
          p.settings -> 'onboardingState' ->> 'onboardingIntent',
          ''
        ) <> 'self_host'
        and nullif(
          p.settings -> 'onboardingState' ->> 'setupHelpRequestedAt',
          ''
        ) is null
        and not exists (
          select 1
          from practice_conversion_milestones activated
          where activated.practice_id = p.id
            and activated.milestone = 'activated'
        )
        and coalesce(email_history.email_count, 0) < 2
      order by p.created_at, p.id
      limit ${SETUP_RECOVERY_RUN_LIMIT}
    `),
  );
  return rowsFromExecute<CandidateRow>(result);
}

async function setupRecoveryStillEligible(
  tx: Database,
  candidate: CandidateRow,
  expectedState: ReturnType<typeof setupRecoveryState>,
  expectedAttempt: 1 | 2,
  now: Date,
): Promise<boolean> {
  const result = await tx.execute(sql`
    select
      p.billing_status as "billingStatus",
      p.trial_ends_at as "trialEndsAt",
      p.created_at as "createdAt",
      p.settings,
      exists (
        select 1
        from practice_conversion_milestones pcm
        where pcm.practice_id = p.id
          and pcm.milestone = 'activated'
      ) as activated
    from practices p
    where p.id = ${candidate.practiceId}::uuid
      and p.deleted_at is null
      and p.recovery_hold = false
    limit 1
  `);
  const current =
    rowsFromExecute<
      Pick<
        CandidateRow,
        "billingStatus" | "trialEndsAt" | "createdAt" | "settings" | "activated"
      >
    >(result)[0];
  if (!current) return false;

  const currentState = setupRecoveryState(current.settings, current.createdAt);
  if (
    currentState.stage !== expectedState.stage ||
    currentState.lastProgressAt.getTime() !==
      expectedState.lastProgressAt.getTime()
  ) {
    return false;
  }

  return (
    setupRecoveryAttempt({
      now,
      billingStatus: current.billingStatus,
      trialEndsAt: current.trialEndsAt,
      activated: current.activated,
      state: currentState,
      existingEmailCount: Number(candidate.existingEmailCount) || 0,
      lastEmailAt: candidate.lastEmailAt,
    }) === expectedAttempt
  );
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  if (!billingEnforced()) {
    await reportCronHeartbeat({
      job: "setup-recovery",
      status: "ok",
      detail: "Hosted billing disabled; no setup recovery emails sent",
      metrics: { disabled: true, sent: 0 },
    });
    return NextResponse.json({ disabled: true, sent: 0 });
  }

  try {
    const now = new Date();
    const candidates = await setupRecoveryCandidates();
    let eligible = 0;
    let sent = 0;
    let deduped = 0;
    let suppressed = 0;
    let failed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const state = setupRecoveryState(candidate.settings, candidate.createdAt);
      const attempt = setupRecoveryAttempt({
        now,
        billingStatus: candidate.billingStatus,
        trialEndsAt: candidate.trialEndsAt,
        activated: candidate.activated,
        state,
        existingEmailCount: Number(candidate.existingEmailCount) || 0,
        lastEmailAt: candidate.lastEmailAt,
      });
      if (!attempt) {
        skipped++;
        continue;
      }

      eligible++;
      const copy = setupRecoveryCopy(state.stage);
      const result = await sendOptionalPlatformEmail({
        practiceId: candidate.practiceId,
        to: candidate.adminEmail,
        emailType: "setup-recovery",
        dedupeKey: setupRecoveryDedupeKey(candidate.practiceId, attempt),
        retryOnFail: true,
        stillEligible: (tx) =>
          setupRecoveryStillEligible(tx, candidate, state, attempt, now),
        send: () =>
          sendSetupRecoveryEmail({
            to: candidate.adminEmail,
            practiceName: candidate.practiceName,
            stepTitle: copy.stepTitle,
            nextAction: copy.nextAction,
            attemptNumber: attempt,
          }),
      });

      if (result.sent) sent++;
      else if (result.suppressed) suppressed++;
      else if (result.deduped) deduped++;
      else failed++;
    }

    const detail = `${sent} sent, ${deduped} deduped, ${suppressed} suppressed, ${failed} failed, ${skipped} skipped`;
    await reportCronHeartbeat({
      job: "setup-recovery",
      status: failed > 0 ? "degraded" : "ok",
      detail,
      metrics: {
        candidates: candidates.length,
        eligible,
        sent,
        deduped,
        suppressed,
        failed,
        skipped,
      },
    });
    return NextResponse.json({
      candidates: candidates.length,
      eligible,
      sent,
      deduped,
      suppressed,
      failed,
      skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Setup recovery cron failed", message);
    await reportCronHeartbeat({
      job: "setup-recovery",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
