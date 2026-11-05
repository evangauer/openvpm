import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { billingEnforced } from "@/lib/billing/plans";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { sendDemoFollowupEmail } from "@/lib/email";
import {
  DEMO_FOLLOWUP_MAX_EMAILS,
  DEMO_FOLLOWUP_SEQUENCE,
  demoFollowupConfig,
  demoFollowupDedupeKey,
  demoFollowupMaxEmails,
  demoFollowupStepDue,
} from "@/lib/growth/demo-followup";
import { sendLeadEmail } from "@/lib/growth/lead-email";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEMO_FOLLOWUP_RUN_LIMIT = 100;

interface CandidateRow {
  leadId: string;
  email: string;
  anonymousId: string | null;
  disclosureVersion: string;
  firstSeenAt: Date | string;
  toolCount: number | string;
  topTool: string | null;
  existingEmailCount: number | string;
  lastEmailAt: Date | string | null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * A demo lead still worth following up: not paused by a person, and not yet
 * a clinic user. Creating an account with the same address ends the sequence.
 */
function openDemoLead(rolloutAt: Date): SQL {
  return sql`
    l.deleted_at is null
    and l.paused_at is null
    and l.source = 'demo'
    and l.first_seen_at >= ${rolloutAt.toISOString()}::timestamptz
    and not exists (
      select 1
      from users u
      where lower(u.email) = l.email
        and u.deleted_at is null
    )
  `;
}

async function demoFollowupCandidates(
  rolloutAt: Date,
): Promise<CandidateRow[]> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      select
        l.id as "leadId",
        l.email,
        l.anonymous_id as "anonymousId",
        l.disclosure_version as "disclosureVersion",
        l.first_seen_at as "firstSeenAt",
        coalesce(tools.tool_count, 0)::int as "toolCount",
        tools.top_tool as "topTool",
        coalesce(history.email_count, 0)::int as "existingEmailCount",
        history.last_email_at as "lastEmailAt"
      from growth_leads l
      left join lateral (
        select
          count(distinct fe.metadata ->> 'tool')::int as tool_count,
          (
            array_agg(fe.metadata ->> 'tool' order by fe.created_at)
              filter (
                where fe.metadata ->> 'tool' not in ('dashboard', 'settings', 'other')
              )
          )[1] as top_tool
        from funnel_events fe
        where l.anonymous_id is not null
          and fe.anonymous_id = l.anonymous_id
          and fe.event_name = 'demo_tool_opened'
      ) tools on true
      left join lateral (
        select
          count(*)::int as email_count,
          max(e.created_at) as last_email_at
        from growth_lead_emails e
        where e.lead_id = l.id
          and e.sequence = ${DEMO_FOLLOWUP_SEQUENCE}
      ) history on true
      where ${openDemoLead(rolloutAt)}
        and l.first_seen_at <= now() - interval '3 hours'
        and coalesce(history.email_count, 0) < ${DEMO_FOLLOWUP_MAX_EMAILS}
      order by l.first_seen_at, l.id
      limit ${DEMO_FOLLOWUP_RUN_LIMIT}
    `),
  );
  return rowsFromExecute<CandidateRow>(result);
}

/** Re-checked under the send lock: signing up or a pause stops mail. */
async function demoFollowupStillEligible(
  tx: Database,
  leadId: string,
  rolloutAt: Date,
): Promise<boolean> {
  const result = await tx.execute(sql`
    select 1 as eligible
    from growth_leads l
    where l.id = ${leadId}::uuid
      and ${openDemoLead(rolloutAt)}
    limit 1
  `);
  return rowsFromExecute<{ eligible: number }>(result).length > 0;
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const config = demoFollowupConfig();
  const disabledReason = !billingEnforced()
    ? "billing_disabled"
    : !config.enabled
      ? config.reason
      : null;
  if (disabledReason || !config.enabled) {
    await reportCronHeartbeat({
      job: "demo-followup",
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
    const candidates = await demoFollowupCandidates(config.rolloutAt);
    let eligible = 0;
    let sent = 0;
    let deduped = 0;
    let suppressed = 0;
    let failed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const step = demoFollowupStepDue({
        now,
        firstSeenAt: candidate.firstSeenAt,
        existingEmailCount: Number(candidate.existingEmailCount) || 0,
        lastEmailAt: candidate.lastEmailAt,
        maxEmails: demoFollowupMaxEmails({
          disclosureVersion: candidate.disclosureVersion,
          toolCount: Number(candidate.toolCount) || 0,
        }),
      });
      if (!step) {
        skipped++;
        continue;
      }

      eligible++;
      const dedupeKey = demoFollowupDedupeKey(candidate.leadId, step);
      const result = await sendLeadEmail({
        leadId: candidate.leadId,
        to: candidate.email,
        sequence: DEMO_FOLLOWUP_SEQUENCE,
        step,
        dedupeKey,
        stillEligible: (tx) =>
          demoFollowupStillEligible(tx, candidate.leadId, config.rolloutAt),
        send: () =>
          sendDemoFollowupEmail({
            to: candidate.email,
            step,
            topTool: candidate.topTool,
            anonymousId: candidate.anonymousId,
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
      job: "demo-followup",
      status: failed > 0 ? "degraded" : "ok",
      detail: `${sent} sent, ${deduped} deduped, ${suppressed} suppressed, ${failed} failed, ${skipped} skipped`,
      metrics,
    });
    return NextResponse.json(metrics);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Demo follow-up cron failed", message);
    await reportCronHeartbeat({
      job: "demo-followup",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
