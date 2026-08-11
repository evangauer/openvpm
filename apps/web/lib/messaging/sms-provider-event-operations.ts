import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";

export const SMS_PROVIDER_EVENT_STALE_MINUTES = 15;

export type SmsProviderEventBlockingState =
  | "pending"
  | "retry"
  | "blocked_recovery"
  | "quarantined";

export type SmsProviderEventOperationalState =
  | SmsProviderEventBlockingState
  | "identity_conflict";

export interface SmsProviderEventGateSummary {
  pending: number;
  retry: number;
  blockedRecovery: number;
  quarantined: number;
  conflicts: number;
  exactPractice: number;
  unresolved: number;
  total: number;
  watermark: Date | null;
}

export interface SmsProviderEventQueueItem {
  eventId: string;
  receivedAt: Date;
  practiceId: string | null;
  locationId: string | null;
  practiceName: string;
  locationName: string | null;
  provider: string;
  kind: "inbound" | "delivery" | "a2p";
  state: SmsProviderEventOperationalState;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  stale: boolean;
}

export interface SmsProviderEventQueue {
  cacheControl: "no-store";
  generatedAt: string;
  counts: {
    pending: number;
    retry: number;
    blockedRecovery: number;
    quarantined: number;
    conflicts: number;
    stale: number;
  };
  items: SmsProviderEventQueueItem[];
  truncated: boolean;
}

/**
 * Final dispatch barrier for provider evidence that cannot safely coexist with
 * a send. The caller must already hold the practice row and the exact recipient
 * advisory lock, in that order. Quarantine/conflict is deliberately an all-send
 * block because the conflicting payload may represent STOP or carrier action.
 */
export async function hasBlockingSmsProviderEventForDispatchInTransaction(
  tx: Database,
  practiceId: string,
  destinationE164: string,
): Promise<boolean> {
  const result = await tx.execute(sql`
    select exists (
      select 1
      from sms_provider_events event
      where (
          event.practice_id = ${practiceId}::uuid
          or (
            event.practice_id is null
            and exists (
              select 1
              from location_messaging sender
              left join messaging_registrations registration
                on registration.practice_id = sender.practice_id
                and registration.deleted_at is null
              where sender.practice_id = ${practiceId}::uuid
                and sender.deleted_at is null
                and sender.provider = event.provider
                and (
                  event.to_e164 = sender.sender_e164
                  or event.messaging_profile_id = sender.messaging_profile_id
                  or event.a2p_phone_e164 = sender.sender_e164
                  or event.a2p_brand_id = registration.provider_brand_id
                  or event.a2p_campaign_id = registration.provider_campaign_id
                )
            )
          )
          or (
            event.practice_id is null
            and event.provider_message_id is not null
            and exists (
              select 1
              from sms_send_attempts attempt
              join sms_send_attempt_events accepted
                on accepted.practice_id = attempt.practice_id
                and accepted.attempt_id = attempt.id
                and accepted.outcome = 'accepted'
                and accepted.provider_message_id = event.provider_message_id
              where attempt.practice_id = ${practiceId}::uuid
                and attempt.provider = event.provider
            )
          )
        )
        and (
          (
            event.kind = 'inbound'
            and event.inbound_classification = 'stop'
            and event.from_e164 = ${destinationE164}
            and event.state in ('pending', 'retry', 'blocked_recovery')
          )
          or (
            event.kind = 'a2p'
            and event.state in ('pending', 'retry', 'blocked_recovery', 'quarantined')
          )
          or event.state = 'quarantined'
          or exists (
            select 1
            from sms_provider_event_conflicts conflict
            where conflict.original_event_id = event.id
              and not exists (
                select 1
                from sms_provider_event_conflict_reviews review
                where review.conflict_id = conflict.id
              )
          )
        )
    ) as "blocked"
  `);
  return rowsFromExecute<{ blocked: boolean }>(result)[0]?.blocked === true;
}

type GateSummaryRow = {
  pending: number;
  retry: number;
  blockedRecovery: number;
  quarantined: number;
  conflicts: number;
  exactPractice: number;
  unresolved: number;
  watermark: Date | string | null;
};

type QueueCountRow = {
  pending: number;
  retry: number;
  blockedRecovery: number;
  quarantined: number;
  conflicts: number;
  stale: number;
};

type QueueRow = Omit<
  SmsProviderEventQueueItem,
  "receivedAt" | "nextAttemptAt" | "lastAttemptAt" | "stale"
> & {
  receivedAt: Date | string;
  nextAttemptAt: Date | string | null;
  lastAttemptAt: Date | string | null;
  stale: boolean;
};

function dateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A recovery/activation gate is broader than the already-attributed queue.
 * Besides exact tenant rows, it includes unresolved evidence that matches a
 * current sender/registration/accepted attempt. Recovery may additionally pass
 * a hold watermark, which intentionally blocks every unresolved event received
 * since the hold began while the hosted rollout remains a single-clinic pilot.
 */
export async function loadSmsProviderEventGateSummaryInTransaction(
  tx: Database,
  input: {
    practiceId: string;
    locationId?: string;
    unresolvedSince?: Date;
  },
): Promise<SmsProviderEventGateSummary> {
  const result = await tx.execute(sql`
    with relevant_events as (
      select event.*,
        case when event.practice_id = ${input.practiceId}::uuid
          then true else false end as exact_practice,
        case when event.practice_id is null then true else false end as unresolved
      from sms_provider_events event
      where event.state in ('pending', 'retry', 'blocked_recovery', 'quarantined')
        and (
          event.practice_id = ${input.practiceId}::uuid
          or (
            event.practice_id is null
            and (
              ${input.unresolvedSince ?? null}::timestamptz is not null
              and event.received_at >= ${input.unresolvedSince ?? null}::timestamptz
            )
          )
          or (
            event.practice_id is null
            and exists (
              select 1
              from location_messaging sender
              left join messaging_registrations registration
                on registration.practice_id = sender.practice_id
                and registration.deleted_at is null
              where sender.practice_id = ${input.practiceId}::uuid
                and sender.deleted_at is null
                and event.provider = sender.provider
                and (${input.locationId ?? null}::uuid is null
                  or sender.location_id = ${input.locationId ?? null}::uuid)
                and (
                  event.messaging_profile_id = sender.messaging_profile_id
                  or event.to_e164 = sender.sender_e164
                  or event.a2p_phone_e164 = sender.sender_e164
                  or event.a2p_brand_id = registration.provider_brand_id
                  or event.a2p_campaign_id = registration.provider_campaign_id
                )
            )
          )
          or (
            event.practice_id is null
            and event.provider_message_id is not null
            and exists (
              select 1
              from sms_send_attempts attempt
              join sms_send_attempt_events accepted
                on accepted.practice_id = attempt.practice_id
                and accepted.attempt_id = attempt.id
                and accepted.outcome = 'accepted'
                and accepted.provider_message_id = event.provider_message_id
              where attempt.practice_id = ${input.practiceId}::uuid
                and attempt.provider = event.provider
                and (${input.locationId ?? null}::uuid is null
                  or attempt.location_id = ${input.locationId ?? null}::uuid)
            )
          )
        )
    ), relevant_conflicts as (
      select conflict.received_at
      from sms_provider_event_conflicts conflict
      join sms_provider_events event on event.id = conflict.original_event_id
      where not exists (
          select 1
          from sms_provider_event_conflict_reviews review
          where review.conflict_id = conflict.id
        )
        and (
          event.practice_id = ${input.practiceId}::uuid
          or (
            event.practice_id is null
            and ${input.unresolvedSince ?? null}::timestamptz is not null
            and conflict.received_at >= ${input.unresolvedSince ?? null}::timestamptz
          )
          or (
            event.practice_id is null
            and exists (
              select 1
              from location_messaging sender
              left join messaging_registrations registration
                on registration.practice_id = sender.practice_id
                and registration.deleted_at is null
              where sender.practice_id = ${input.practiceId}::uuid
                and sender.deleted_at is null
                and event.provider = sender.provider
                and (${input.locationId ?? null}::uuid is null
                  or sender.location_id = ${input.locationId ?? null}::uuid)
                and (
                  event.messaging_profile_id = sender.messaging_profile_id
                  or event.to_e164 = sender.sender_e164
                  or event.a2p_phone_e164 = sender.sender_e164
                  or event.a2p_brand_id = registration.provider_brand_id
                  or event.a2p_campaign_id = registration.provider_campaign_id
                )
            )
          )
          or (
            event.practice_id is null
            and event.provider_message_id is not null
            and exists (
              select 1
              from sms_send_attempts attempt
              join sms_send_attempt_events accepted
                on accepted.practice_id = attempt.practice_id
                and accepted.attempt_id = attempt.id
                and accepted.outcome = 'accepted'
                and accepted.provider_message_id = event.provider_message_id
              where attempt.practice_id = ${input.practiceId}::uuid
                and attempt.provider = event.provider
                and (${input.locationId ?? null}::uuid is null
                  or attempt.location_id = ${input.locationId ?? null}::uuid)
            )
          )
        )
    )
    select
      count(*) filter (where state = 'pending')::int as pending,
      count(*) filter (where state = 'retry')::int as retry,
      count(*) filter (where state = 'blocked_recovery')::int as "blockedRecovery",
      count(*) filter (where state = 'quarantined')::int as quarantined,
      (select count(*)::int from relevant_conflicts) as conflicts,
      count(*) filter (where exact_practice)::int as "exactPractice",
      count(*) filter (where unresolved)::int as unresolved,
      greatest(
        max(received_at),
        (select max(received_at) from relevant_conflicts)
      ) as watermark
    from relevant_events
  `);
  const row = rowsFromExecute<GateSummaryRow>(result)[0];
  const summary = {
    pending: numberValue(row?.pending),
    retry: numberValue(row?.retry),
    blockedRecovery: numberValue(row?.blockedRecovery),
    quarantined: numberValue(row?.quarantined),
    conflicts: numberValue(row?.conflicts),
    exactPractice: numberValue(row?.exactPractice),
    unresolved: numberValue(row?.unresolved),
    watermark: dateOrNull(row?.watermark ?? null),
  };
  return {
    ...summary,
    total:
      summary.pending +
      summary.retry +
      summary.blockedRecovery +
      summary.quarantined +
      summary.conflicts,
  };
}

export async function loadSmsProviderEventQueue(
  database: Database,
  options: { practiceId?: string; limit?: number; now?: Date } = {},
): Promise<SmsProviderEventQueue> {
  const now = options.now ?? new Date();
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const staleBefore = new Date(
    now.getTime() - SMS_PROVIDER_EVENT_STALE_MINUTES * 60 * 1000,
  );

  return withSystem(database, async (tx) => {
    const scope = options.practiceId
      ? sql`event.practice_id = ${options.practiceId}::uuid`
      : sql`true`;
    const countResult = await tx.execute(sql`
      with scoped_events as (
        select event.state, event.received_at, event.next_attempt_at
        from sms_provider_events event
        where ${scope}
          and event.state in ('pending', 'retry', 'blocked_recovery', 'quarantined')
      ), scoped_conflicts as (
        select conflict.id
        from sms_provider_event_conflicts conflict
        join sms_provider_events event on event.id = conflict.original_event_id
        where ${scope}
          and not exists (
            select 1
            from sms_provider_event_conflict_reviews review
            where review.conflict_id = conflict.id
          )
      )
      select
        count(*) filter (where state = 'pending')::int as pending,
        count(*) filter (where state = 'retry')::int as retry,
        count(*) filter (where state = 'blocked_recovery')::int as "blockedRecovery",
        count(*) filter (where state = 'quarantined')::int as quarantined,
        (select count(*)::int from scoped_conflicts) as conflicts,
        count(*) filter (
          where state in ('pending', 'retry')
            and received_at <= ${staleBefore}
            and (next_attempt_at is null or next_attempt_at <= ${now})
        )::int as stale
      from scoped_events
    `);
    const countRow = rowsFromExecute<QueueCountRow>(countResult)[0];

    const queueResult = await tx.execute(sql`
      with queue as (
        select
          event.id as "eventId",
          event.received_at as "receivedAt",
          event.practice_id as "practiceId",
          event.location_id as "locationId",
          coalesce(practice.name, 'Unattributed provider event') as "practiceName",
          location.name as "locationName",
          event.provider,
          event.kind,
          event.state::text as state,
          event.attempt_count as "attemptCount",
          event.next_attempt_at as "nextAttemptAt",
          event.last_attempt_at as "lastAttemptAt",
          event.last_error_code as "lastErrorCode",
          (
            event.state in ('pending', 'retry')
            and event.received_at <= ${staleBefore}
            and (event.next_attempt_at is null or event.next_attempt_at <= ${now})
          ) as stale,
          case event.state
            when 'quarantined' then 0
            when 'blocked_recovery' then 1
            when 'retry' then 2
            else 3
          end as priority
        from sms_provider_events event
        left join practices practice on practice.id = event.practice_id
        left join locations location
          on location.id = event.location_id
          and location.practice_id = event.practice_id
        where ${scope}
          and event.state in ('pending', 'retry', 'blocked_recovery', 'quarantined')

        union all

        select
          event.id as "eventId",
          conflict.received_at as "receivedAt",
          event.practice_id as "practiceId",
          event.location_id as "locationId",
          coalesce(practice.name, 'Unattributed provider event') as "practiceName",
          location.name as "locationName",
          event.provider,
          event.kind,
          'identity_conflict'::text as state,
          event.attempt_count as "attemptCount",
          null::timestamptz as "nextAttemptAt",
          event.last_attempt_at as "lastAttemptAt",
          'provider_event_identity_conflict'::text as "lastErrorCode",
          true as stale,
          -1 as priority
        from sms_provider_event_conflicts conflict
        join sms_provider_events event on event.id = conflict.original_event_id
        left join practices practice on practice.id = event.practice_id
        left join locations location
          on location.id = event.location_id
          and location.practice_id = event.practice_id
        where ${scope}
          and not exists (
            select 1
            from sms_provider_event_conflict_reviews review
            where review.conflict_id = conflict.id
          )
      )
      select *
      from queue
      order by priority, "receivedAt", "eventId"
      limit ${limit + 1}
    `);
    const rows = rowsFromExecute<QueueRow>(queueResult);

    return {
      cacheControl: "no-store" as const,
      generatedAt: now.toISOString(),
      counts: {
        pending: numberValue(countRow?.pending),
        retry: numberValue(countRow?.retry),
        blockedRecovery: numberValue(countRow?.blockedRecovery),
        quarantined: numberValue(countRow?.quarantined),
        conflicts: numberValue(countRow?.conflicts),
        stale: numberValue(countRow?.stale),
      },
      items: rows.slice(0, limit).map((row) => ({
        ...row,
        receivedAt: dateOrNull(row.receivedAt)!,
        nextAttemptAt: dateOrNull(row.nextAttemptAt),
        lastAttemptAt: dateOrNull(row.lastAttemptAt),
        stale: Boolean(row.stale),
      })),
      truncated: rows.length > limit,
    };
  });
}
