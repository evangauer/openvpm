import { and, asc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import {
  communications,
  smsDeliveryEventHistory,
  smsDeliveryEvents,
  smsSendAttemptEvents,
  smsSendAttempts,
} from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";

function redactedOperatorIdentity(value: string | null): string | null {
  if (!value) return null;
  const [local, domain] = value.split("@");
  if (!local || !domain) return "reviewer-recorded";
  return `${local.slice(0, 1)}***@${domain}`;
}

export interface SmsDeliveryQueueInput {
  practiceId?: string;
  staleMinutes: number;
  limit: number;
  now?: Date;
}

export interface SmsSendQueueInput {
  practiceId?: string;
  staleMinutes: number;
  limit: number;
  now?: Date;
}

/** Exact shared loader for the platform-admin delivery evidence queue. */
export async function loadSmsDeliveryEventQueue(
  db: Database,
  input: SmsDeliveryQueueInput,
) {
  return withSystem(db, async (tx) => {
    const attributedPracticeId = sql<string | null>`(
      select attributed.practice_id
      from sms_delivery_event_history attributed
      where attributed.delivery_event_id = ${smsDeliveryEvents.id}
        and attributed.result = 'attributed'
      limit 1
    )`;
    const attributedAttemptId = sql<string | null>`(
      select attributed.attempt_id
      from sms_delivery_event_history attributed
      where attributed.delivery_event_id = ${smsDeliveryEvents.id}
        and attributed.result = 'attributed'
      limit 1
    )`;
    const attributedLocationId = sql<string | null>`(
      select attributed_attempt.location_id
      from sms_send_attempts attributed_attempt
      where attributed_attempt.practice_id = ${attributedPracticeId}
        and attributed_attempt.id = ${attributedAttemptId}
      limit 1
    )`;
    const hasAttribution = sql<boolean>`exists (
      select 1
      from sms_delivery_event_history attributed
      where attributed.delivery_event_id = ${smsDeliveryEvents.id}
        and attributed.result = 'attributed'
    )`;
    const hasPendingAmbiguity = sql<boolean>`exists (
      select 1
      from sms_delivery_event_history conflict
      where conflict.delivery_event_id = ${smsDeliveryEvents.id}
        and conflict.result = 'ambiguous'
        and not exists (
          select 1
          from sms_delivery_event_history review
          where review.reviewed_history_id = conflict.id
        )
    )`;
    const hasPendingUnmatched = sql<boolean>`exists (
      select 1
      from sms_delivery_event_history unmatched
      where unmatched.delivery_event_id = ${smsDeliveryEvents.id}
        and unmatched.result = 'unmatched'
        and not exists (
          select 1
          from sms_delivery_event_history any_conflict
          where any_conflict.delivery_event_id = unmatched.delivery_event_id
            and any_conflict.result = 'ambiguous'
        )
        and not exists (
          select 1
          from sms_delivery_event_history review
          where review.reviewed_history_id = unmatched.id
        )
    )`;
    const pendingHistoryId = sql<string | null>`(
      select pending.id
      from sms_delivery_event_history pending
      where pending.delivery_event_id = ${smsDeliveryEvents.id}
        and pending.result in ('ambiguous', 'unmatched')
        and (
          pending.result = 'ambiguous'
          or not exists (
            select 1
            from sms_delivery_event_history any_conflict
            where any_conflict.delivery_event_id = pending.delivery_event_id
              and any_conflict.result = 'ambiguous'
          )
        )
        and not exists (
          select 1
          from sms_delivery_event_history review
          where review.reviewed_history_id = pending.id
        )
      order by
        case when pending.result = 'ambiguous' then 0 else 1 end,
        pending.created_at desc,
        pending.id desc
      limit 1
    )`;
    const effectiveClassification = sql<string>`coalesce(
      (
        select reconciliation.classification::text
        from sms_delivery_event_history reconciliation
        where reconciliation.delivery_event_id = ${smsDeliveryEvents.id}
          and reconciliation.result = 'reconciled'
        order by reconciliation.created_at desc, reconciliation.id desc
        limit 1
      ),
      ${smsDeliveryEvents.classification}::text
    )`;
    const latestProjectionResult = sql<string | null>`(
      select projection.result::text
      from sms_delivery_event_history projection
      where projection.delivery_event_id = ${smsDeliveryEvents.id}
        and projection.result in ('projected', 'projection_miss')
      order by projection.created_at desc, projection.id desc
      limit 1
    )`;
    const operatorReviewed = sql<boolean>`exists (
      select 1
      from sms_delivery_event_history review
      where review.delivery_event_id = ${smsDeliveryEvents.id}
        and review.result = 'operator_reviewed'
    )`;
    const latestReviewAt = sql<Date | null>`(
      select review.created_at
      from sms_delivery_event_history review
      where review.delivery_event_id = ${smsDeliveryEvents.id}
        and review.result = 'operator_reviewed'
      order by review.created_at desc, review.id desc
      limit 1
    )`;
    const latestReviewReason = sql<string | null>`(
      select review.operator_reason_code::text
      from sms_delivery_event_history review
      where review.delivery_event_id = ${smsDeliveryEvents.id}
        and review.result = 'operator_reviewed'
      order by review.created_at desc, review.id desc
      limit 1
    )`;
    const latestReviewerName = sql<string | null>`(
      select review.actor_name
      from sms_delivery_event_history review
      where review.delivery_event_id = ${smsDeliveryEvents.id}
        and review.result = 'operator_reviewed'
      order by review.created_at desc, review.id desc
      limit 1
    )`;
    const latestReviewerIdentity = sql<string | null>`(
      select review.actor_identity
      from sms_delivery_event_history review
      where review.delivery_event_id = ${smsDeliveryEvents.id}
        and review.result = 'operator_reviewed'
      order by review.created_at desc, review.id desc
      limit 1
    )`;

    const rows = await tx
      .select({
        eventId: smsDeliveryEvents.id,
        receivedAt: smsDeliveryEvents.receivedAt,
        provider: smsDeliveryEvents.provider,
        providerEventType: smsDeliveryEvents.providerEventType,
        providerStatus: smsDeliveryEvents.providerStatus,
        providerErrorCode: smsDeliveryEvents.providerErrorCode,
        classification: smsDeliveryEvents.classification,
        practiceId: attributedPracticeId,
        locationId: attributedLocationId,
        attemptId: attributedAttemptId,
        pendingHistoryId,
        operatorReviewed,
        latestReviewAt,
        latestReviewReason,
        latestReviewerName,
        latestReviewerIdentity,
        queueReason: sql<
          | "identity_conflict"
          | "unmatched"
          | "unknown_status"
          | "projection_miss"
        >`case
            when ${hasPendingAmbiguity} then 'identity_conflict'
            when not (${hasAttribution}) and ${hasPendingUnmatched} then 'unmatched'
            when ${hasAttribution} and ${effectiveClassification} = 'unknown' then 'unknown_status'
            else 'projection_miss'
          end`,
      })
      .from(smsDeliveryEvents)
      .where(
        and(
          input.practiceId
            ? sql`${attributedPracticeId} = ${input.practiceId}`
            : undefined,
          sql`(
            ${hasPendingAmbiguity}
            or (not (${hasAttribution}) and ${hasPendingUnmatched})
            or (${hasAttribution} and ${effectiveClassification} = 'unknown')
            or ${latestProjectionResult} = 'projection_miss'
          )`,
        ),
      )
      .orderBy(asc(smsDeliveryEvents.receivedAt), asc(smsDeliveryEvents.id))
      .limit(input.limit);

    const receiptCutoff = new Date(
      (input.now ?? new Date()).getTime() - input.staleMinutes * 60 * 1000,
    );
    const acceptedProviderMessageId = sql<string | null>`coalesce(
      (
        select accepted_reconciliation.provider_message_id
        from sms_send_attempt_events accepted_reconciliation
        where accepted_reconciliation.practice_id = ${smsSendAttempts.practiceId}
          and accepted_reconciliation.attempt_id = ${smsSendAttempts.id}
          and accepted_reconciliation.kind = 'reconciliation'
          and accepted_reconciliation.outcome = 'accepted'
        order by accepted_reconciliation.created_at desc, accepted_reconciliation.id desc
        limit 1
      ),
      (
        select accepted_result.provider_message_id
        from sms_send_attempt_events accepted_result
        where accepted_result.practice_id = ${smsSendAttempts.practiceId}
          and accepted_result.attempt_id = ${smsSendAttempts.id}
          and accepted_result.kind = 'provider_result'
          and accepted_result.outcome = 'accepted'
        order by accepted_result.created_at desc, accepted_result.id desc
        limit 1
      )
    )`;
    const acceptedAt = sql<Date | null>`coalesce(
      (
        select accepted_reconciliation.created_at
        from sms_send_attempt_events accepted_reconciliation
        where accepted_reconciliation.practice_id = ${smsSendAttempts.practiceId}
          and accepted_reconciliation.attempt_id = ${smsSendAttempts.id}
          and accepted_reconciliation.kind = 'reconciliation'
          and accepted_reconciliation.outcome = 'accepted'
        order by accepted_reconciliation.created_at desc, accepted_reconciliation.id desc
        limit 1
      ),
      (
        select accepted_result.created_at
        from sms_send_attempt_events accepted_result
        where accepted_result.practice_id = ${smsSendAttempts.practiceId}
          and accepted_result.attempt_id = ${smsSendAttempts.id}
          and accepted_result.kind = 'provider_result'
          and accepted_result.outcome = 'accepted'
        order by accepted_result.created_at desc, accepted_result.id desc
        limit 1
      )
    )`;
    const missingReceiptRows = await tx
      .select({
        eventId: sql<null>`null::uuid`,
        receivedAt: acceptedAt,
        provider: smsSendAttempts.provider,
        providerEventType: sql<string>`'message.status'`,
        providerStatus: sql<null>`null::text`,
        providerErrorCode: sql<null>`null::text`,
        classification: sql<"unknown">`'unknown'`,
        practiceId: smsSendAttempts.practiceId,
        locationId: smsSendAttempts.locationId,
        attemptId: smsSendAttempts.id,
        pendingHistoryId: sql<null>`null::uuid`,
        operatorReviewed: sql<false>`false`,
        latestReviewAt: sql<null>`null::timestamptz`,
        latestReviewReason: sql<null>`null::text`,
        latestReviewerName: sql<null>`null::text`,
        latestReviewerIdentity: sql<null>`null::text`,
        queueReason: sql<"stale_without_final_delivery">`'stale_without_final_delivery'`,
      })
      .from(smsSendAttempts)
      .where(
        and(
          ne(smsSendAttempts.provider, "console"),
          sql`${acceptedProviderMessageId} is not null`,
          sql`${acceptedAt} <= ${receiptCutoff}`,
          input.practiceId
            ? eq(smsSendAttempts.practiceId, input.practiceId)
            : undefined,
          sql`not exists (
            select 1
            from sms_delivery_events receipt
            where receipt.provider = ${smsSendAttempts.provider}
              and receipt.provider_message_id = ${acceptedProviderMessageId}
              and (
                (
                  receipt.provider = 'telnyx'
                  and (
                    receipt.provider_event_type = 'message.finalized'
                    or receipt.classification in ('failed', 'delivered')
                  )
                )
                or (
                  receipt.provider = 'twilio'
                  and receipt.classification in ('failed', 'delivered')
                )
              )
          )`,
        ),
      )
      .orderBy(asc(acceptedAt), asc(smsSendAttempts.id))
      .limit(input.limit);

    return {
      cacheControl: "no-store" as const,
      items: rows.map((row) => ({
        ...row,
        latestReviewerIdentity: redactedOperatorIdentity(
          row.latestReviewerIdentity,
        ),
        providerMessageHint: null,
      })),
      staleAcceptedWithoutFinalDelivery: missingReceiptRows.map((row) => ({
        ...row,
        latestReviewerIdentity: null,
        providerMessageHint: null,
      })),
    };
  });
}

/** Exact shared loader for the platform-admin durable send-attempt queue. */
export async function loadSmsSendAttemptQueue(
  db: Database,
  input: SmsSendQueueInput,
) {
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - input.staleMinutes * 60 * 1000,
  );
  return withSystem(db, async (tx) => {
    const hasAnyEvent = sql<boolean>`exists (
      select 1
      from sms_send_attempt_events queue_event
      where queue_event.practice_id = ${smsSendAttempts.practiceId}
        and queue_event.attempt_id = ${smsSendAttempts.id}
    )`;
    const effectiveOutcome = sql<string | null>`coalesce(
      (
        select reconciliation.outcome::text
        from sms_send_attempt_events reconciliation
        where reconciliation.practice_id = ${smsSendAttempts.practiceId}
          and reconciliation.attempt_id = ${smsSendAttempts.id}
          and reconciliation.kind = 'reconciliation'
        order by reconciliation.created_at desc, reconciliation.id desc
        limit 1
      ),
      (
        select provider_result.outcome::text
        from sms_send_attempt_events provider_result
        where provider_result.practice_id = ${smsSendAttempts.practiceId}
          and provider_result.attempt_id = ${smsSendAttempts.id}
          and provider_result.kind = 'provider_result'
        order by provider_result.created_at desc, provider_result.id desc
        limit 1
      )
    )`;
    const attemptItems = await tx
      .select({
        attemptId: smsSendAttempts.id,
        practiceId: smsSendAttempts.practiceId,
        locationId: smsSendAttempts.locationId,
        createdAt: smsSendAttempts.createdAt,
        communicationId: smsSendAttempts.communicationId,
        source: smsSendAttempts.source,
        provider: smsSendAttempts.provider,
        classification: sql<
          | "missing_provider_result"
          | "outcome_unknown"
          | "terminal_projection_pending"
        >`case
            when not (${hasAnyEvent}) then 'missing_provider_result'
            when (${effectiveOutcome}) = 'outcome_unknown' then 'outcome_unknown'
            else 'terminal_projection_pending'
          end`,
      })
      .from(smsSendAttempts)
      .where(
        and(
          lte(smsSendAttempts.createdAt, cutoff),
          input.practiceId
            ? eq(smsSendAttempts.practiceId, input.practiceId)
            : undefined,
          sql`(
            (${effectiveOutcome}) is null
            or (${effectiveOutcome}) = 'outcome_unknown'
            or (
              (${effectiveOutcome}) in ('accepted', 'definite_failure')
              and exists (
                select 1
                from communications pending_projection
                where pending_projection.practice_id = ${smsSendAttempts.practiceId}
                  and pending_projection.id = ${smsSendAttempts.communicationId}
                  and pending_projection.status = 'pending'
                  and pending_projection.deleted_at is null
              )
            )
          )`,
        ),
      )
      .orderBy(asc(smsSendAttempts.createdAt), asc(smsSendAttempts.id))
      .limit(input.limit);
    const orphanItems = await tx
      .select({
        attemptId: sql<string | null>`null::uuid`,
        practiceId: communications.practiceId,
        locationId: sql<null>`null::uuid`,
        createdAt: communications.createdAt,
        communicationId: communications.id,
        source: sql<"communication_claim">`'communication_claim'`,
        provider: sql<null>`null::text`,
        classification: sql<"orphan_pending_communication">`'orphan_pending_communication'`,
      })
      .from(communications)
      .where(
        and(
          lte(communications.createdAt, cutoff),
          eq(communications.channel, "sms"),
          eq(communications.direction, "outbound"),
          eq(communications.status, "pending"),
          isNull(communications.deletedAt),
          input.practiceId
            ? eq(communications.practiceId, input.practiceId)
            : undefined,
          sql`not exists (
            select 1
            from sms_send_attempts orphan_attempt
            where orphan_attempt.practice_id = ${communications.practiceId}
              and orphan_attempt.communication_id = ${communications.id}
          )`,
        ),
      )
      .orderBy(asc(communications.createdAt), asc(communications.id))
      .limit(input.limit);
    const items = [...attemptItems, ...orphanItems]
      .sort((left, right) => {
        const byTime =
          new Date(left.createdAt).getTime() -
          new Date(right.createdAt).getTime();
        if (byTime !== 0) return byTime;
        return (left.attemptId ?? left.communicationId ?? "").localeCompare(
          right.attemptId ?? right.communicationId ?? "",
        );
      })
      .slice(0, input.limit);
    return { cacheControl: "no-store" as const, items };
  });
}
