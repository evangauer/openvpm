import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { billingEnforced } from "@/lib/billing/plans";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { sendCheckoutRecoveryEmail } from "@/lib/email";
import { sendOptionalPlatformEmail } from "@/lib/email-lifecycle";
import {
  CHECKOUT_RECOVERY_MAX_EMAILS,
  checkoutRecoveryConfig,
  CHECKOUT_RECOVERY_DEDUPE_BASE,
  checkoutRecoveryDedupeKey,
  checkoutRecoveryStepDue,
} from "@/lib/growth/checkout-recovery";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CHECKOUT_RECOVERY_RUN_LIMIT = 100;

interface CandidateRow {
  practiceId: string;
  practiceName: string;
  createdAt: Date | string;
  adminEmail: string;
  adminName: string | null;
  adminVerified: boolean;
  previewActive: boolean;
  existingEmailCount: number | string;
  lastEmailAt: Date | string | null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * A hosted registration that never started a trial or subscription. Lapsed
 * trials, self-hosters, clinics that asked for help, and clinics that already
 * told us why they stopped all belong to other paths.
 */
function neverTrialedPractice(rolloutAt: Date): SQL {
  return sql`
    p.deleted_at is null
    and p.recovery_hold = false
    and p.settings ->> 'analyticsExcluded' is distinct from 'true'
    and p.created_at >= ${rolloutAt.toISOString()}::timestamptz
    and p.billing_status = 'none'
    and p.stripe_subscription_id is null
    and p.trial_ends_at is null
    and coalesce(p.settings -> 'onboardingState' ->> 'onboardingIntent', '')
      <> 'self_host'
    and nullif(
      p.settings -> 'onboardingState' ->> 'setupHelpRequestedAt',
      ''
    ) is null
    and nullif(p.settings -> 'growthLead' ->> 'stopReasonAt', '') is null
  `;
}

async function checkoutRecoveryCandidates(
  rolloutAt: Date,
): Promise<CandidateRow[]> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      select
        p.id as "practiceId",
        p.name as "practiceName",
        p.created_at as "createdAt",
        admin.email as "adminEmail",
        admin.name as "adminName",
        admin.email_verified_at is not null as "adminVerified",
        coalesce(p.preview_ends_at > now(), false) as "previewActive",
        coalesce(email_history.email_count, 0)::int as "existingEmailCount",
        email_history.last_email_at as "lastEmailAt"
      from practices p
      join lateral (
        select u.email, u.name, u.email_verified_at
        from users u
        where u.practice_id = p.id
          and u.role = 'admin'
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
          and c.dedupe_key like (${CHECKOUT_RECOVERY_DEDUPE_BASE} || p.id::text || ':%')
      ) email_history on true
      where ${neverTrialedPractice(rolloutAt)}
        and p.created_at <= now() - interval '1 hour'
        and coalesce(email_history.email_count, 0) < ${CHECKOUT_RECOVERY_MAX_EMAILS}
      order by p.created_at, p.id
      limit ${CHECKOUT_RECOVERY_RUN_LIMIT}
    `),
  );
  return rowsFromExecute<CandidateRow>(result);
}

/** Re-checked under the send lock: starting a trial or answering stops mail. */
async function checkoutRecoveryStillEligible(
  tx: Database,
  practiceId: string,
  rolloutAt: Date,
): Promise<boolean> {
  const result = await tx.execute(sql`
    select 1 as eligible
    from practices p
    where p.id = ${practiceId}::uuid
      and ${neverTrialedPractice(rolloutAt)}
    limit 1
  `);
  return rowsFromExecute<{ eligible: number }>(result).length > 0;
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const config = checkoutRecoveryConfig();
  const disabledReason = !billingEnforced()
    ? "billing_disabled"
    : !config.enabled
      ? config.reason
      : null;
  if (disabledReason || !config.enabled) {
    await reportCronHeartbeat({
      job: "checkout-recovery",
      status: "ok",
      detail: `Campaign disabled: ${disabledReason}`,
      metrics: { sent: 0, reason: disabledReason ?? "disabled" },
    });
    return NextResponse.json({
      disabled: true,
      reason: disabledReason,
      sent: 0,
    });
  }

  try {
    const now = new Date();
    const candidates = await checkoutRecoveryCandidates(config.rolloutAt);
    let eligible = 0;
    let sent = 0;
    let deduped = 0;
    let suppressed = 0;
    let failed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const step = checkoutRecoveryStepDue({
        now,
        createdAt: candidate.createdAt,
        existingEmailCount: Number(candidate.existingEmailCount) || 0,
        lastEmailAt: candidate.lastEmailAt,
        recipientVerified: candidate.adminVerified === true,
      });
      if (!step) {
        skipped++;
        continue;
      }

      eligible++;
      const dedupeKey = checkoutRecoveryDedupeKey(candidate.practiceId, step);
      const result = await sendOptionalPlatformEmail({
        practiceId: candidate.practiceId,
        to: candidate.adminEmail,
        emailType: "checkout-recovery",
        dedupeKey,
        retryOnFail: true,
        stillEligible: (tx) =>
          checkoutRecoveryStillEligible(
            tx,
            candidate.practiceId,
            config.rolloutAt,
          ),
        send: () =>
          sendCheckoutRecoveryEmail({
            to: candidate.adminEmail,
            practiceId: candidate.practiceId,
            practiceName: candidate.practiceName,
            adminName: candidate.adminName,
            step,
            previewActive: candidate.previewActive === true,
            idempotencyKey: dedupeKey,
          }),
      });

      if (result.sent) sent++;
      else if (result.suppressed) suppressed++;
      else if (result.deduped) deduped++;
      else failed++;
    }

    const metrics = {
      candidates: candidates.length,
      eligible,
      sent,
      deduped,
      suppressed,
      failed,
      skipped,
    };
    await reportCronHeartbeat({
      job: "checkout-recovery",
      status: failed > 0 ? "degraded" : "ok",
      detail: `${sent} sent, ${deduped} deduped, ${suppressed} suppressed, ${failed} failed, ${skipped} skipped`,
      metrics,
    });
    return NextResponse.json(metrics);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Checkout recovery cron failed", message);
    await reportCronHeartbeat({
      job: "checkout-recovery",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
