import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { rowsFromExecute } from "@/lib/db/execute-rows";

import type { PracticeTracking, TrackingCursor } from "./practice-tracking-types";

function acquisitionValue(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,80}$/.test(value) ? value : null;
}

/** Operator-only projection of registered accounts, including before checkout,
 * shared by the dashboard, email and signed Atlas feed.
 * Reads only counts and allowlisted audit labels: no prompts, notes, tokens or IPs.
 * Cursor pages are stable for a fixed upper registration-time bound.
 */
export async function loadPracticeTracking(
  db: Database,
  { limit = 50, cursor, asOf = new Date() }: {
    limit?: number; cursor?: TrackingCursor; asOf?: Date;
  } = {},
) {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(limit)));
  const result = await withSystem(db, tx => tx.execute(sql`
    with selected as materialized (
      select p.* from practices p
      where p.deleted_at is null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
        and p.created_at <= ${asOf.toISOString()}::timestamptz
        ${cursor ? sql`and (p.created_at, p.id) <
          (${cursor.createdAt}::timestamptz, ${cursor.practiceId}::uuid)` : sql``}
      order by p.created_at desc, p.id desc limit ${pageSize + 1}
    )
    select jsonb_build_object(
      'practiceId',p.id, 'businessName',p.name,
      'ownerName',owner.name, 'ownerEmail',owner.email,
      'emailVerifiedAt',owner.email_verified_at, 'registeredAt',p.created_at,
      'billingStatus',p.billing_status, 'trialEndsAt',p.trial_ends_at,
      'acquisition',jsonb_build_object(
        'signupSource',p.settings->'acquisition'->>'source',
        'medium',p.settings->'acquisition'->>'medium',
        'campaign',p.settings->'acquisition'->>'campaign'),
      'usage',jsonb_build_object(
        'clients',(select count(*) from clients r where r.practice_id=p.id and r.deleted_at is null
          and not(coalesce(p.settings->'demoData'->'clientIds','[]'::jsonb) @> to_jsonb(r.id::text))),
        'patients',(select count(*) from patients r where r.practice_id=p.id and r.deleted_at is null
          and not(coalesce(p.settings->'demoData'->'patientIds','[]'::jsonb) @> to_jsonb(r.id::text))),
        'appointments',(select count(*) from appointments r where r.practice_id=p.id and r.deleted_at is null
          and not(coalesce(p.settings->'demoData'->'appointmentIds','[]'::jsonb) @> to_jsonb(r.id::text))),
        'soapNotes',(select count(*) from soap_notes r where r.practice_id=p.id and r.deleted_at is null
          and not(coalesce(p.settings->'demoData'->'soapNoteIds','[]'::jsonb) @> to_jsonb(r.id::text))),
        'invoices',(select count(*) from invoices r where r.practice_id=p.id and r.deleted_at is null
          and not(coalesce(p.settings->'demoData'->'invoiceIds','[]'::jsonb) @> to_jsonb(r.id::text))),
        'files',(select count(*) from files r where r.practice_id=p.id and r.deleted_at is null),
        'captureSessions',(select count(*) from capture_sessions r where r.practice_id=p.id and r.deleted_at is null),
        'aiRuns',(select coalesce(sum(quantity),0) from usage_records r where r.practice_id=p.id and r.kind='ai_run' and r.deleted_at is null),
        'sms',(select coalesce(sum(quantity),0) from usage_records r where r.practice_id=p.id and r.kind='sms' and r.deleted_at is null)),
      'lastActionAt',activity.last_at,
      'activeDays7',activity.days7, 'activeDays30',activity.days30,
      'actions',coalesce(activity.actions,'[]'::jsonb)
    ) as tracking
    from selected p
    left join lateral (
      select name,email,email_verified_at from users
      where practice_id=p.id and role='admin' and deleted_at is null
      order by created_at,id limit 1
    ) owner on true
    left join lateral (
      with labeled as (
        select created_at,case
          when entity_type='agent' and action='run' then 'AI run'
          when entity_type='appointments' and action='create' then 'Appointment created'
          when entity_type='appointments' and action='update' then 'Appointment updated'
          when entity_type='records' and action='createCaptureSession' then 'Document capture started'
          when entity_type='clients' and action='create' then 'Client created'
          when entity_type='patients' and action='create' then 'Patient created'
          when entity_type='invoices' and action='create' then 'Invoice created'
          when entity_type='clinical_note' and action='created' then 'Clinical note created'
          else null end as label
        from audit_log where practice_id=p.id and deleted_at is null
          and created_at <= ${asOf.toISOString()}::timestamptz
      ), recorded as (select * from labeled where label is not null)
      select max(created_at) as last_at,
        count(distinct (created_at at time zone 'UTC')::date)
          filter(where created_at >= (date_trunc('day', ${asOf.toISOString()}::timestamptz at time zone 'UTC') at time zone 'UTC') - interval '6 days')::int as days7,
        count(distinct (created_at at time zone 'UTC')::date)
          filter(where created_at >= (date_trunc('day', ${asOf.toISOString()}::timestamptz at time zone 'UTC') at time zone 'UTC') - interval '29 days')::int as days30,
        (select jsonb_agg(jsonb_build_object('label',label,'count',n,'lastAt',last_at) order by last_at desc)
          from (select label,count(*) as n,max(created_at) as last_at from recorded group by label) grouped) as actions
      from recorded
    ) activity on true
    order by p.created_at desc,p.id desc
  `));
  const fetched = rowsFromExecute<{ tracking: PracticeTracking }>(result).map(r => r.tracking);
  const practices = fetched.slice(0, pageSize).map(p => ({
    ...p,
    acquisition: {
      signupSource: acquisitionValue(p.acquisition.signupSource),
      medium: acquisitionValue(p.acquisition.medium),
      campaign: acquisitionValue(p.acquisition.campaign),
    },
  }));
  const last = practices.at(-1);
  return {
    snapshotAt: asOf.toISOString(), practices,
    nextCursor: fetched.length > pageSize && last
      ? { createdAt: last.registeredAt, practiceId: last.practiceId } : null,
  };
}
