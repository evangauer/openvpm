import { sql } from "drizzle-orm";

/**
 * Shared raw-SQL predicate for queries whose provider-event table alias is
 * `event`. A terminal quarantine is remediated only when its base incident (if
 * required) and every independently arriving identity conflict have durable,
 * typed resolution evidence. A later conflict therefore reopens every gate.
 */
export const smsProviderEventQuarantineIsRemediatedSql = sql`(
  (
    exists (
      select 1
      from sms_provider_event_resolutions base_resolution
      where base_resolution.event_id = event.id
        and base_resolution.conflict_id is null
    )
    or (
      event.last_error_code = 'provider_identity_conflict'
      and exists (
        select 1
        from sms_provider_event_conflicts initial_conflict
        where initial_conflict.original_event_id = event.id
      )
    )
  )
  and not exists (
    select 1
    from sms_provider_event_conflicts unresolved_conflict
    where unresolved_conflict.original_event_id = event.id
      and (
        not exists (
          select 1
          from sms_provider_event_conflict_reviews conflict_review
          where conflict_review.conflict_id = unresolved_conflict.id
        )
        or not exists (
          select 1
          from sms_provider_event_resolutions conflict_resolution
          where conflict_resolution.conflict_id = unresolved_conflict.id
        )
      )
  )
)`;
