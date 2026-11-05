import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";

export const DEMO_LEADS_LIMIT = 100;

export interface DemoLead {
  leadId: string;
  email: string;
  disclosureVersion: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
  toolCount: number;
  firstTool: string | null;
  emailsSent: number;
  lastEmailAt: Date | null;
  registered: boolean;
  pausedAt: Date | null;
}

interface DemoLeadRow {
  leadId: string;
  email: string;
  disclosureVersion: string;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  seenCount: number | string;
  toolCount: number | string;
  firstTool: string | null;
  emailsSent: number | string;
  lastEmailAt: Date | string | null;
  registered: boolean;
  pausedAt: Date | string | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Most recent demo leads with what they explored and what we've sent. */
export async function listDemoLeads(db: Database): Promise<DemoLead[]> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      select
        l.id as "leadId",
        l.email,
        l.disclosure_version as "disclosureVersion",
        l.first_seen_at as "firstSeenAt",
        l.last_seen_at as "lastSeenAt",
        l.seen_count as "seenCount",
        coalesce(tools.tool_count, 0)::int as "toolCount",
        tools.first_tool as "firstTool",
        coalesce(sent.email_count, 0)::int as "emailsSent",
        sent.last_email_at as "lastEmailAt",
        exists (
          select 1 from users u
          where lower(u.email) = l.email and u.deleted_at is null
        ) as registered,
        l.paused_at as "pausedAt"
      from growth_leads l
      left join lateral (
        select
          count(distinct fe.metadata ->> 'tool')::int as tool_count,
          (
            array_agg(fe.metadata ->> 'tool' order by fe.created_at)
              filter (
                where fe.metadata ->> 'tool' not in ('dashboard', 'settings', 'other')
              )
          )[1] as first_tool
        from funnel_events fe
        where l.anonymous_id is not null
          and fe.anonymous_id = l.anonymous_id
          and fe.event_name = 'demo_tool_opened'
      ) tools on true
      left join lateral (
        select count(*)::int as email_count, max(e.created_at) as last_email_at
        from growth_lead_emails e
        where e.lead_id = l.id and e.status = 'sent'
      ) sent on true
      where l.deleted_at is null and l.source = 'demo'
      order by l.last_seen_at desc, l.id
      limit ${DEMO_LEADS_LIMIT}
    `),
  );
  return rowsFromExecute<DemoLeadRow>(result).map((row) => ({
    leadId: row.leadId,
    email: row.email,
    disclosureVersion: row.disclosureVersion,
    firstSeenAt: toDate(row.firstSeenAt),
    lastSeenAt: toDate(row.lastSeenAt),
    seenCount: Number(row.seenCount) || 0,
    toolCount: Number(row.toolCount) || 0,
    firstTool: row.firstTool,
    emailsSent: Number(row.emailsSent) || 0,
    lastEmailAt: row.lastEmailAt ? toDate(row.lastEmailAt) : null,
    registered: row.registered === true,
    pausedAt: row.pausedAt ? toDate(row.pausedAt) : null,
  }));
}

/** A person took over the conversation: stop (or resume) automated email. */
export async function setDemoLeadPaused(
  db: Database,
  leadId: string,
  paused: boolean,
): Promise<boolean> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      update growth_leads
      set paused_at = ${paused ? sql`now()` : sql`null`}, updated_at = now()
      where id = ${leadId}::uuid and deleted_at is null
      returning id
    `),
  );
  return rowsFromExecute<{ id: string }>(result).length > 0;
}
