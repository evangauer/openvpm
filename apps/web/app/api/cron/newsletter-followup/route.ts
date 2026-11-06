import { sql, type SQL } from "drizzle-orm";
import { db, type Database } from "@openpims/db/client";
import { billingEnforced } from "@/lib/billing/plans";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { sendNewsletterEmail } from "@/lib/email";
import { sendLeadEmail } from "@/lib/growth/lead-email";
import { NEWSLETTER_DISCLOSURE, NEWSLETTER_SEQUENCE, newsletterFollowupConfig, newsletterStepDue, parseNewsletterSubscription } from "@/lib/growth/newsletter";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
interface Candidate {
  id: string; email: string; anonymousId: string | null; subscription: unknown;
  sentSteps: number[]; lastEmailAt: string | Date | null;
}
function eligibility(rolloutAt: Date, now: Date): SQL {
  // Stored timestamps are canonical UTC ISO strings. Parse and validate below,
  // rather than casting arbitrary JSON strings to dates in the database.
  return sql`l.deleted_at is null and l.paused_at is null
    and l.newsletter_subscription ->> 'welcomeStoppedAt' is null
    and l.newsletter_subscription ->> 'disclosureVersion' = ${NEWSLETTER_DISCLOSURE}
    and l.newsletter_subscription ->> 'confirmedAt' >= ${rolloutAt.toISOString()}
    and l.newsletter_subscription ->> 'confirmedAt' >= ${new Date(now.getTime() - 30 * 86400_000).toISOString()}
    and not exists (select 1 from users u where lower(u.email) = l.email and u.deleted_at is null)`;
}
async function candidates(tx: Database, rolloutAt: Date, now: Date, leadId?: string): Promise<Candidate[]> {
  const result = await tx.execute(sql`
    select l.id, l.email, l.anonymous_id as "anonymousId", l.newsletter_subscription as subscription,
      coalesce(h.steps, '{}') as "sentSteps", h.last_email_at as "lastEmailAt"
    from growth_leads l left join lateral (
      select array_agg(e.step) filter (where e.status = 'sent') as steps,
        max(e.created_at) filter (where e.status = 'sent') as last_email_at
      from growth_lead_emails e where e.lead_id = l.id and e.sequence = ${NEWSLETTER_SEQUENCE}
    ) h on true
    where ${eligibility(rolloutAt, now)} ${leadId ? sql`and l.id = ${leadId}::uuid` : sql``}
      and (
        not (1 = any(coalesce(h.steps, '{}')))
        or (not (2 = any(coalesce(h.steps, '{}'))) and l.newsletter_subscription ->> 'confirmedAt' <= ${new Date(now.getTime() - 48 * 3600_000).toISOString()})
        or (not (3 = any(coalesce(h.steps, '{}'))) and l.newsletter_subscription ->> 'confirmedAt' <= ${new Date(now.getTime() - 168 * 3600_000).toISOString()})
      )
      and (h.last_email_at is null or h.last_email_at <= ${new Date(now.getTime() - 86400_000).toISOString()}::timestamptz)
    order by h.last_email_at nulls first, l.id limit 100
  `);
  return rowsFromExecute<Candidate>(result);
}
function due(row: Candidate, now: Date, rolloutAt: Date) {
  const subscription = parseNewsletterSubscription(row.subscription);
  if (!subscription?.confirmedAt || Date.parse(subscription.confirmedAt) < rolloutAt.getTime()) return null;
  const step = newsletterStepDue({ now, confirmedAt: subscription.confirmedAt, sentSteps: row.sentSteps, lastEmailAt: row.lastEmailAt });
  return step ? { step, subscription } : null;
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;
  const config = newsletterFollowupConfig();
  if (!billingEnforced() || !config) {
    await reportCronHeartbeat({ job: "newsletter-followup", status: "ok", detail: "Campaign disabled", metrics: { sent: 0 } });
    return Response.json({ disabled: true, sent: 0 });
  }
  try {
    const now = new Date();
    const rows = await withSystem(db, tx => candidates(tx, config.rolloutAt, now));
    const tally = { candidates: rows.length, sent: 0, skipped: 0, suppressed: 0, deduped: 0, failed: 0 };
    for (const row of rows) {
      const next = due(row, now, config.rolloutAt);
      if (!next) { tally.skipped++; continue; }
      const dedupeKey = `lead:${NEWSLETTER_SEQUENCE}:${row.id}:${next.step}`;
      const result = await sendLeadEmail({ leadId: row.id, to: row.email, sequence: NEWSLETTER_SEQUENCE, step: next.step, dedupeKey,
        stillEligible: async tx => {
          const fresh = (await candidates(tx, config.rolloutAt, new Date(), row.id))[0];
          return !!fresh && due(fresh, new Date(), config.rolloutAt)?.step === next.step;
        },
        send: () => sendNewsletterEmail({ to: row.email, step: next.step, interest: next.subscription.interest, anonymousId: row.anonymousId, idempotencyKey: dedupeKey }),
      });
      if (result.sent) tally.sent++;
      else if (result.suppressed) {
        tally.suppressed++;
        // A stopped introduction stays stopped if preferences later change.
        // Retire it from the queue so suppressed addresses cannot starve new ones.
        await withSystem(db, tx => tx.execute(sql`update growth_leads set
          newsletter_subscription = jsonb_set(newsletter_subscription, '{welcomeStoppedAt}', to_jsonb(${new Date().toISOString()}::text)),
          updated_at = now() where id = ${row.id}::uuid`));
      }
      else if (result.deduped) tally.deduped++;
      else tally.failed++;
    }
    await reportCronHeartbeat({ job: "newsletter-followup", status: tally.failed ? "degraded" : "ok", metrics: tally });
    return Response.json(tally);
  } catch {
    await reportCronHeartbeat({ job: "newsletter-followup", status: "failed", detail: "Newsletter follow-up failed" });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
