import { NextResponse } from "next/server";
import { and, eq, gt, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db, type Database } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { billingEnforced } from "@/lib/billing/plans";
import { billingContactEmail } from "@/lib/billing/contact";
import { firstClinicWinConfig } from "@/lib/billing/first-clinic-win";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { sendFirstClinicWinEmail } from "@/lib/email";
import { sendOptionalPlatformEmail } from "@/lib/email-lifecycle";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CANDIDATE_LIMIT = 100;

type Candidate = {
  id: string;
  name: string;
  email: string | null;
  timezone: string | null;
  trialEndsAt: Date | null;
};

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const config = firstClinicWinConfig();
  const hostedBillingEnabled = billingEnforced();
  if (!hostedBillingEnabled) {
    const reason = "billing_disabled";
    await reportCronHeartbeat({
      job: "first-clinic-win",
      status: "ok",
      detail: `Campaign disabled: ${reason}`,
      metrics: { sent: 0, deduped: 0, suppressed: 0, failed: 0, reason },
    });
    return NextResponse.json({
      sent: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      disabled: true,
      reason,
    });
  }
  if (!config.enabled) {
    const reason = config.reason;
    await reportCronHeartbeat({
      job: "first-clinic-win",
      status: "ok",
      detail: `Campaign disabled: ${reason}`,
      metrics: { sent: 0, deduped: 0, suppressed: 0, failed: 0, reason },
    });
    return NextResponse.json({
      sent: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      disabled: true,
      reason,
    });
  }

  try {
    const now = new Date();
    const candidates = await withSystem(db, (tx) =>
      tx
        .select({
          id: practices.id,
          name: practices.name,
          email: practices.email,
          timezone: practices.timezone,
          trialEndsAt: practices.trialEndsAt,
        })
        .from(practices)
        .where(firstClinicWinEligibility(config.rolloutAt, now))
        .orderBy(practices.id)
        .limit(CANDIDATE_LIMIT),
    );

    let sent = 0;
    let deduped = 0;
    let suppressed = 0;
    let failed = 0;

    for (const candidate of candidates as Candidate[]) {
      const to = billingContactEmail(candidate.email);
      const trialEndsAt = candidate.trialEndsAt
        ? new Date(candidate.trialEndsAt)
        : null;
      if (!to || !trialEndsAt) {
        suppressed++;
        continue;
      }

      const dedupeKey = `lc:first-clinic-win:v1:${candidate.id}`;
      const result = await sendOptionalPlatformEmail({
        practiceId: candidate.id,
        to,
        emailType: "first-clinic-win",
        dedupeKey,
        retryOnFail: true,
        stillEligible: (tx) =>
          firstClinicWinStillEligible(tx, {
            practiceId: candidate.id,
            to,
            rolloutAt: config.rolloutAt,
          }),
        send: () =>
          sendFirstClinicWinEmail({
            to,
            practiceName: candidate.name,
            trialEndDate: formatTrialEndDate(
              trialEndsAt,
              candidate.timezone ?? undefined,
            ),
            idempotencyKey: dedupeKey,
          }),
      });

      if (result.sent) sent++;
      else if (result.suppressed) suppressed++;
      else if (result.deduped) deduped++;
      else failed++;
    }

    const status = failed > 0 ? "degraded" : "ok";
    await reportCronHeartbeat({
      job: "first-clinic-win",
      status,
      detail: `${sent} sent, ${deduped} deduped, ${suppressed} suppressed, ${failed} failed`,
      metrics: {
        candidates: candidates.length,
        sent,
        deduped,
        suppressed,
        failed,
        candidateLimit: CANDIDATE_LIMIT,
      },
    });
    return NextResponse.json({ sent, deduped, suppressed, failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await alertOps("First clinic win cron failed", message);
    await reportCronHeartbeat({
      job: "first-clinic-win",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

function firstClinicWinEligibility(rolloutAt: Date, now: Date): SQL {
  return and(
    eq(practices.billingStatus, "trialing"),
    gt(practices.trialEndsAt, now),
    isNotNull(practices.trialEndsAt),
    isNull(practices.stripeSubscriptionId),
    eq(practices.recoveryHold, false),
    isNull(practices.deletedAt),
    sql`${practices.settings} ->> 'analyticsExcluded' is distinct from 'true'`,
    sql`exists (
      select 1
      from users u
      where u.practice_id = ${practices.id}
        and u.role = 'admin'
        and u.deleted_at is null
        and u.email_verified_at is not null
        and lower(btrim(u.email)) = lower(btrim(${practices.email}))
    )`,
    sql`not exists (
      select 1
      from practice_conversion_milestones pcm
      where pcm.practice_id = ${practices.id}
        and pcm.milestone = 'payment_method_collected'
    )`,
    // Keep the bounded sweep moving forward. A terminal claim means this
    // practice has already been handled; a pending claim remains eligible so
    // sendLifecycleEmail can either observe the in-flight worker or reclaim a
    // stale attempt after its bounded recovery window.
    sql`not exists (
      select 1
      from communications c
      where c.dedupe_key = 'lc:first-clinic-win:v1:' || ${practices.id}::text
        and c.status <> 'pending'::comm_status
    )`,
    sql`exists (
      select 1
      from visit_closeouts vc
      join appointments a
        on a.id = vc.appointment_id
       and a.practice_id = ${practices.id}
       and a.deleted_at is null
       and a.status = 'checked_out'
      where vc.practice_id = ${practices.id}
        and vc.status = 'completed'
        and vc.deleted_at is null
        and vc.completed_at >= ${rolloutAt}
        and not (
          coalesce(${practices.settings} -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
            @> to_jsonb(a.id::text)
        )
    )`,
  )!;
}

async function firstClinicWinStillEligible(
  tx: Database,
  input: { practiceId: string; to: string; rolloutAt: Date },
): Promise<boolean> {
  const [practice] = await tx
    .select({ id: practices.id, email: practices.email })
    .from(practices)
    .where(
      and(
        eq(practices.id, input.practiceId),
        firstClinicWinEligibility(input.rolloutAt, new Date()),
      ),
    )
    .limit(1);
  return billingContactEmail(practice?.email) === input.to;
}

function formatTrialEndDate(date: Date, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "long",
    day: "numeric",
    year: "numeric",
  };
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(date);
  }
}
