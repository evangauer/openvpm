import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { billingEnforced } from "@/lib/billing/plans";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { sendBuildFollowupEmail } from "@/lib/email";
import {
  BUILD_FOLLOWUP_MAX_EMAILS,
  BUILD_FOLLOWUP_SEQUENCE,
  buildFollowupConfig,
  buildFollowupDedupeKey,
  buildFollowupStepDue,
} from "@/lib/build/followup";
import { parseBuildProgress } from "@/lib/build/progress";
import { sendLeadEmail } from "@/lib/growth/lead-email";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUILD_FOLLOWUP_RUN_LIMIT = 100;

interface CandidateRow {
  leadId: string;
  email: string;
  anonymousId: string | null;
  buildProgress: unknown;
  existingEmailCount: number | string;
  lastEmailAt: Date | string | null;
}

/**
 * A saved build still worth a note: not paused by a person, saved after
 * rollout, and its owner hasn't created an account with that address.
 */
function openBuild(rolloutAt: Date): SQL {
  return sql`
    l.deleted_at is null
    and l.paused_at is null
    and l.build_progress is not null
    and (l.build_progress ->> 'savedAt') ~ '^[0-9]{4}-'
    and (l.build_progress ->> 'savedAt')::timestamptz
      >= ${rolloutAt.toISOString()}::timestamptz
    and not exists (
      select 1 from users u
      where lower(u.email) = l.email and u.deleted_at is null
    )
  `;
}

async function candidates(rolloutAt: Date): Promise<CandidateRow[]> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      select
        l.id as "leadId",
        l.email,
        l.anonymous_id as "anonymousId",
        l.build_progress as "buildProgress",
        coalesce(history.email_count, 0)::int as "existingEmailCount",
        history.last_email_at as "lastEmailAt"
      from growth_leads l
      left join lateral (
        select count(*)::int as email_count, max(e.created_at) as last_email_at
        from growth_lead_emails e
        where e.lead_id = l.id and e.sequence = ${BUILD_FOLLOWUP_SEQUENCE}
      ) history on true
      where ${openBuild(rolloutAt)}
        and (l.build_progress ->> 'savedAt')::timestamptz <= now() - interval '2 hours'
        and coalesce(history.email_count, 0) < ${BUILD_FOLLOWUP_MAX_EMAILS}
      order by (l.build_progress ->> 'savedAt')::timestamptz, l.id
      limit ${BUILD_FOLLOWUP_RUN_LIMIT}
    `),
  );
  return rowsFromExecute<CandidateRow>(result);
}

/** Re-checked under the send lock: signing up or a pause stops mail. */
async function stillEligible(
  tx: Database,
  leadId: string,
  rolloutAt: Date,
): Promise<boolean> {
  const result = await tx.execute(sql`
    select 1 as eligible from growth_leads l
    where l.id = ${leadId}::uuid and ${openBuild(rolloutAt)}
    limit 1
  `);
  return rowsFromExecute<{ eligible: number }>(result).length > 0;
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const config = buildFollowupConfig();
  const disabledReason = !billingEnforced()
    ? "billing_disabled"
    : !config.enabled
      ? config.reason
      : null;
  if (disabledReason || !config.enabled) {
    await reportCronHeartbeat({
      job: "build-followup",
      status: "ok",
      detail: `Campaign disabled: ${disabledReason}`,
      metrics: { sent: 0, reason: disabledReason ?? "disabled" },
    });
    return NextResponse.json({ disabled: true, reason: disabledReason, sent: 0 });
  }

  try {
    const now = new Date();
    const rows = await candidates(config.rolloutAt);
    const tally = { candidates: rows.length, sent: 0, deduped: 0, suppressed: 0, failed: 0, skipped: 0 };

    for (const row of rows) {
      const progress = parseBuildProgress(row.buildProgress);
      const step = progress
        ? buildFollowupStepDue({
            now,
            savedAt: progress.savedAt,
            existingEmailCount: Number(row.existingEmailCount) || 0,
            lastEmailAt: row.lastEmailAt,
          })
        : null;
      if (!progress || !step) {
        tally.skipped++;
        continue;
      }
      const dedupeKey = buildFollowupDedupeKey(row.leadId, step);
      const result = await sendLeadEmail({
        leadId: row.leadId,
        to: row.email,
        sequence: BUILD_FOLLOWUP_SEQUENCE,
        step,
        dedupeKey,
        stillEligible: (tx) => stillEligible(tx, row.leadId, config.rolloutAt),
        send: () =>
          sendBuildFollowupEmail({
            to: row.email,
            leadId: row.leadId,
            step,
            state: progress.state,
            anonymousId: row.anonymousId,
            idempotencyKey: dedupeKey,
          }),
      });
      if (result.sent) tally.sent++;
      else if (result.suppressed) tally.suppressed++;
      else if (result.deduped) tally.deduped++;
      else tally.failed++;
    }

    await reportCronHeartbeat({
      job: "build-followup",
      status: tally.failed > 0 ? "degraded" : "ok",
      detail: `${tally.sent} sent, ${tally.deduped} deduped, ${tally.suppressed} suppressed, ${tally.failed} failed, ${tally.skipped} skipped`,
      metrics: tally,
    });
    return NextResponse.json(tally);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Build follow-up cron failed", message);
    await reportCronHeartbeat({ job: "build-followup", status: "failed", detail: message });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
