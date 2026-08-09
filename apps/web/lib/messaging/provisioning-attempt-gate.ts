import { sql } from "drizzle-orm";
import {
  locations,
  locationMessaging,
  practices,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";

type ReserveProfileAttemptInput = {
  practiceId: string;
  locationId: string;
  senderE164: string;
  customerReference: string;
  detail: string;
};

/**
 * Persist the disabled profile-attempt gate through the root database pool,
 * outside the tenant request transaction. That independent commit is required:
 * if the subsequent provider POST times out or the request process exits, the
 * request transaction can roll back without erasing the retry gate.
 */
export async function reserveMessagingProfileAttempt(
  input: ReserveProfileAttemptInput
): Promise<boolean> {
  return withSystem(db, (tx) =>
    reserveMessagingProfileAttemptWithDatabase(tx, input)
  );
}

/** Exported for isolated SQL/result-shape tests; callers use the wrapper above. */
export async function reserveMessagingProfileAttemptWithDatabase(
  database: Pick<Database, "execute">,
  input: ReserveProfileAttemptInput
): Promise<boolean> {
  const result = await database.execute(sql`
    with operation_lock as (
      select pg_advisory_xact_lock(
        hashtextextended(${input.customerReference}, 0)
      )
    ), target_location as (
      select ${locations.id}
      from ${locations}
      cross join operation_lock
      where ${locations.id} = ${input.locationId}
        and ${locations.practiceId} = ${input.practiceId}
        and ${locations.deletedAt} is null
        and exists (
          select 1
          from ${practices}
          where ${practices.id} = ${input.practiceId}
            and ${practices.deletedAt} is null
        )
    )
    insert into ${locationMessaging} (
      practice_id,
      location_id,
      provider,
      messaging_profile_id,
      sender_e164,
      number_source,
      a2p_brand_id,
      a2p_campaign_id,
      registration_status,
      registration_detail,
      enabled
    )
    select
      ${input.practiceId},
      target_location.id,
      'telnyx',
      null,
      ${input.senderE164},
      'purchased',
      null,
      null,
      'failed',
      ${input.detail},
      false
    from target_location
    on conflict (location_id) do update
    set
      practice_id = excluded.practice_id,
      provider = excluded.provider,
      messaging_profile_id = null,
      sender_e164 = excluded.sender_e164,
      number_source = excluded.number_source,
      a2p_brand_id = null,
      a2p_campaign_id = null,
      registration_status = excluded.registration_status,
      registration_detail = excluded.registration_detail,
      enabled = false,
      deleted_at = null,
      updated_at = now()
    where ${locationMessaging.deletedAt} is not null
    returning ${locationMessaging.locationId} as "locationId"
  `);

  return rowsFromExecute<{ locationId: string }>(result).some(
    (row) => row.locationId === input.locationId
  );
}

/**
 * Remove only the exact untouched reservation. This is safe solely before any
 * profile POST and after provider reconciliation conclusively returned no
 * matching state. A soft delete lets a later fresh reservation revive the same
 * unique location row without losing history timestamps.
 */
export async function releaseMessagingProfileAttempt(
  input: ReserveProfileAttemptInput
): Promise<boolean> {
  return withSystem(db, (tx) =>
    releaseMessagingProfileAttemptWithDatabase(tx, input)
  );
}

export async function releaseMessagingProfileAttemptWithDatabase(
  database: Pick<Database, "execute">,
  input: ReserveProfileAttemptInput
): Promise<boolean> {
  const result = await database.execute(sql`
    update ${locationMessaging}
    set
      deleted_at = now(),
      updated_at = now()
    where ${locationMessaging.practiceId} = ${input.practiceId}
      and ${locationMessaging.locationId} = ${input.locationId}
      and ${locationMessaging.provider} = 'telnyx'
      and ${locationMessaging.messagingProfileId} is null
      and ${locationMessaging.senderE164} = ${input.senderE164}
      and ${locationMessaging.numberSource} = 'purchased'
      and ${locationMessaging.registrationStatus} = 'failed'
      and ${locationMessaging.registrationDetail} = ${input.detail}
      and ${locationMessaging.enabled} = false
      and ${locationMessaging.deletedAt} is null
    returning ${locationMessaging.locationId} as "locationId"
  `);

  return rowsFromExecute<{ locationId: string }>(result).some(
    (row) => row.locationId === input.locationId
  );
}
