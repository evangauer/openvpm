import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import {
  communications,
  smsDeliveryEventHistory,
  smsDeliveryEvents,
  smsSendAttemptEvents,
  smsSendAttempts,
} from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";

export type SmsDeliveryProvider = "telnyx" | "twilio";
export type SmsDeliveryClassification =
  | "unknown"
  | "sent"
  | "failed"
  | "delivered";
export type SmsDeliveryReconciliationReason =
  | "exact_attribution_retry"
  | "provider_portal_status_review"
  | "projection_repair"
  | "identity_conflict_review"
  | "unmatched_evidence_review";

type DeliveryEvidence = typeof smsDeliveryEvents.$inferSelect;
type DeliveryAttempt = Pick<
  typeof smsSendAttempts.$inferSelect,
  "id" | "practiceId" | "communicationId"
>;

const DELIVERY_RANK: Record<SmsDeliveryClassification, number> = {
  unknown: 0,
  sent: 1,
  failed: 2,
  delivered: 3,
};

const COMMUNICATION_RANK = {
  pending: 0,
  sent: 1,
  failed: 2,
  delivered: 3,
  read: 3,
} as const;
export const SMS_DELIVERY_ACCEPTED_SWEEP_LIMIT = 100;

export async function lockSmsDeliveryIdentity(
  tx: Database,
  provider: string,
  providerMessageId: string | null | undefined,
) {
  const messageId = bounded(providerMessageId, 255);
  if ((provider !== "telnyx" && provider !== "twilio") || !messageId) return;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sms-delivery:${provider}:${messageId}`}, 0))`,
  );
}

function bounded(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Only provider lifecycle tokens are persisted; arbitrary payload text is not. */
export function redactedProviderToken(
  value: string | null | undefined,
  max = 80,
): string | null {
  const normalized = bounded(value, max);
  return normalized && /^[a-zA-Z0-9_.:-]+$/.test(normalized)
    ? normalized
    : null;
}

export function smsDeliveryFingerprint(input: {
  provider: SmsDeliveryProvider;
  providerEventId?: string | null;
  providerMessageId?: string | null;
  providerEventType: string;
  providerStatus?: string | null;
  providerErrorCode?: string | null;
  occurredAt?: Date | null;
}): string {
  // Deliberately excludes recipient, sender, body and the raw payload. The
  // normalized lifecycle tuple is stable across provider retries and contains
  // no client PII.
  const normalized = [
    input.provider,
    bounded(input.providerEventId, 255) ?? "",
    bounded(input.providerMessageId, 255) ?? "",
    redactedProviderToken(input.providerEventType) ?? "unknown",
    redactedProviderToken(input.providerStatus) ?? "",
    redactedProviderToken(input.providerErrorCode) ?? "",
    input.occurredAt?.toISOString() ?? "",
  ].join("\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function reduceSmsDeliveryStatus(
  current: SmsDeliveryClassification,
  observed: SmsDeliveryClassification,
): SmsDeliveryClassification {
  return DELIVERY_RANK[observed] > DELIVERY_RANK[current] ? observed : current;
}

export function projectSmsCommunicationStatus(
  current: keyof typeof COMMUNICATION_RANK,
  observed: SmsDeliveryClassification,
): keyof typeof COMMUNICATION_RANK {
  if (current === "read" || current === "delivered") return current;
  const currentDelivery: SmsDeliveryClassification =
    current === "pending" ? "unknown" : current;
  const reduced = reduceSmsDeliveryStatus(currentDelivery, observed);
  return reduced === "unknown" ? "pending" : reduced;
}

function eventIdentity(input: {
  providerEventId?: string | null;
  fingerprint: string;
}): string {
  const providerEventId = bounded(input.providerEventId, 255);
  return providerEventId
    ? `event:${createHash("sha256").update(providerEventId, "utf8").digest("hex")}`
    : `fingerprint:${input.fingerprint}`;
}

function conflictingObservationDetail(input: {
  fingerprint: string;
  providerMessageId: string | null;
  providerEventType: string;
  providerStatus: string | null;
  providerErrorCode: string | null;
  occurredAt?: Date | null;
  messageIdDiffers: boolean;
}): string {
  // This is a constructed, bounded lifecycle snapshot, never a callback body.
  // Provider ids are operational identifiers; phone numbers, message content,
  // sender/profile metadata and arbitrary payload fields are not accepted.
  return JSON.stringify({
    fingerprintSha256: input.fingerprint,
    providerMessageId: input.providerMessageId,
    providerEventType: input.providerEventType,
    providerStatus: input.providerStatus,
    providerErrorCode: input.providerErrorCode,
    occurredAt: input.occurredAt?.toISOString() ?? null,
    messageIdDiffers: input.messageIdDiffers,
  });
}

async function appendHistory(
  tx: Database,
  values: typeof smsDeliveryEventHistory.$inferInsert,
) {
  return (
    tx
      .insert(smsDeliveryEventHistory)
      .values({ ...values, createdAt: sql`clock_timestamp()` })
      // Targetless conflict handling also covers the partial one-attribution
      // index when two callback workers race with different candidates.
      .onConflictDoNothing()
      .returning({ id: smsDeliveryEventHistory.id })
  );
}

async function exactAttemptsForEvidence(
  tx: Database,
  evidence: DeliveryEvidence,
): Promise<DeliveryAttempt[]> {
  if (!evidence.providerMessageId) return [];
  const rows = await tx
    .select({
      id: smsSendAttempts.id,
      practiceId: smsSendAttempts.practiceId,
      communicationId: smsSendAttempts.communicationId,
    })
    .from(smsSendAttempts)
    .innerJoin(
      smsSendAttemptEvents,
      and(
        eq(smsSendAttemptEvents.practiceId, smsSendAttempts.practiceId),
        eq(smsSendAttemptEvents.attemptId, smsSendAttempts.id),
        eq(smsSendAttemptEvents.outcome, "accepted"),
        eq(smsSendAttemptEvents.providerMessageId, evidence.providerMessageId),
      ),
    )
    .where(eq(smsSendAttempts.provider, evidence.provider))
    .groupBy(
      smsSendAttempts.id,
      smsSendAttempts.practiceId,
      smsSendAttempts.communicationId,
    )
    .orderBy(smsSendAttempts.practiceId, smsSendAttempts.id)
    .limit(100);

  // A provider result and a later send-attempt reconciliation can both carry
  // the same accepted id for one attempt. They are one exact candidate, not an
  // ambiguity. Distinct attempts remain quarantined.
  return Array.from(new Map(rows.map((row) => [row.id, row])).values());
}

async function existingAttribution(
  tx: Database,
  deliveryEventId: string,
): Promise<DeliveryAttempt | null> {
  const [row] = await tx
    .select({
      id: smsSendAttempts.id,
      practiceId: smsSendAttempts.practiceId,
      communicationId: smsSendAttempts.communicationId,
    })
    .from(smsDeliveryEventHistory)
    .innerJoin(
      smsSendAttempts,
      and(
        eq(smsSendAttempts.practiceId, smsDeliveryEventHistory.practiceId),
        eq(smsSendAttempts.id, smsDeliveryEventHistory.attemptId),
      ),
    )
    .where(
      and(
        eq(smsDeliveryEventHistory.deliveryEventId, deliveryEventId),
        eq(smsDeliveryEventHistory.result, "attributed"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function attributeEvidence(
  tx: Database,
  evidence: DeliveryEvidence,
): Promise<
  | { result: "attributed"; attempt: DeliveryAttempt }
  | { result: "unmatched" | "ambiguous" }
> {
  const prior = await existingAttribution(tx, evidence.id);
  const candidates = await exactAttemptsForEvidence(tx, evidence);
  if (candidates.length !== 1) {
    const result = candidates.length === 0 ? "unmatched" : "ambiguous";
    const candidateSet = candidates
      .map((candidate) => `${candidate.practiceId}:${candidate.id}`)
      .sort()
      .join("|");
    const candidateFingerprint = createHash("sha256")
      .update(candidateSet || "none", "utf8")
      .digest("hex")
      .slice(0, 24);
    await appendHistory(tx, {
      deliveryEventId: evidence.id,
      kind: "automatic",
      result,
      classification: evidence.classification,
      detail:
        result === "unmatched"
          ? "No exact accepted provider-message match exists yet."
          : "Multiple exact provider-message matches require investigation.",
      eventKey: `delivery:${evidence.id}:${result}:candidates:${candidateFingerprint}`,
    });
    return { result };
  }

  const attempt = candidates[0]!;
  if (prior) {
    return prior.id === attempt.id && prior.practiceId === attempt.practiceId
      ? { result: "attributed", attempt: prior }
      : { result: "ambiguous" };
  }
  await appendHistory(tx, {
    deliveryEventId: evidence.id,
    practiceId: attempt.practiceId,
    attemptId: attempt.id,
    communicationId: attempt.communicationId,
    kind: "automatic",
    result: "attributed",
    classification: evidence.classification,
    eventKey: `delivery:${evidence.id}:attributed:${attempt.id}`,
  });

  // The partial unique index makes a racing competing attribution impossible.
  // Re-read the fixed attribution rather than trusting this transaction's
  // candidate after an ON CONFLICT no-op.
  const fixed = await existingAttribution(tx, evidence.id);
  return fixed
    ? { result: "attributed", attempt: fixed }
    : { result: "ambiguous" };
}

async function projectEvidence(
  tx: Database,
  evidence: DeliveryEvidence,
  attempt: DeliveryAttempt,
  classification: SmsDeliveryClassification,
) {
  if (!attempt.communicationId) {
    await appendHistory(tx, {
      deliveryEventId: evidence.id,
      practiceId: attempt.practiceId,
      attemptId: attempt.id,
      kind: "automatic",
      result: "projection_miss",
      classification,
      detail: "The exact send attempt has no linked communication.",
      eventKey: `delivery:${evidence.id}:projection:${classification}:missing-communication`,
    });
    return "projection_miss" as const;
  }

  const [communication] = await tx
    .select({ status: communications.status })
    .from(communications)
    .where(
      and(
        eq(communications.practiceId, attempt.practiceId),
        eq(communications.id, attempt.communicationId),
        eq(communications.channel, "sms"),
        eq(communications.direction, "outbound"),
        isNull(communications.deletedAt),
      ),
    )
    .limit(1);

  if (!communication) {
    await appendHistory(tx, {
      deliveryEventId: evidence.id,
      practiceId: attempt.practiceId,
      attemptId: attempt.id,
      communicationId: attempt.communicationId,
      kind: "automatic",
      result: "projection_miss",
      classification,
      detail: "The linked outbound SMS communication is unavailable.",
      eventKey: `delivery:${evidence.id}:projection:${classification}:missing-row`,
    });
    return "projection_miss" as const;
  }

  const projectedStatus = projectSmsCommunicationStatus(
    communication.status,
    classification,
  );
  const desired =
    projectedStatus === communication.status ? null : projectedStatus;
  if (desired && desired !== "pending" && desired !== "read") {
    const allowedCurrent =
      desired === "sent"
        ? (["pending"] as const)
        : desired === "failed"
          ? (["pending", "sent"] as const)
          : (["pending", "sent", "failed"] as const);
    const [updated] = await tx
      .update(communications)
      .set({ status: desired })
      .where(
        and(
          eq(communications.practiceId, attempt.practiceId),
          eq(communications.id, attempt.communicationId),
          eq(communications.channel, "sms"),
          eq(communications.direction, "outbound"),
          isNull(communications.deletedAt),
          // Atomic compare-and-set prevents a concurrent lower-precedence event
          // from overwriting failed/delivered after the read above.
          inArray(communications.status, [...allowedCurrent]),
        ),
      )
      .returning({ id: communications.id });
    if (!updated) {
      const [current] = await tx
        .select({ status: communications.status })
        .from(communications)
        .where(
          and(
            eq(communications.practiceId, attempt.practiceId),
            eq(communications.id, attempt.communicationId),
            eq(communications.channel, "sms"),
            eq(communications.direction, "outbound"),
            isNull(communications.deletedAt),
          ),
        )
        .limit(1);
      if (
        !current ||
        COMMUNICATION_RANK[current.status] < DELIVERY_RANK[classification]
      ) {
        await appendHistory(tx, {
          deliveryEventId: evidence.id,
          practiceId: attempt.practiceId,
          attemptId: attempt.id,
          communicationId: attempt.communicationId,
          kind: "automatic",
          result: "projection_miss",
          classification,
          detail: "The monotone delivery projection could not be persisted.",
          eventKey: `delivery:${evidence.id}:projection:${classification}:compare-and-set-miss`,
        });
        return "projection_miss" as const;
      }
    }
  }

  await appendHistory(tx, {
    deliveryEventId: evidence.id,
    practiceId: attempt.practiceId,
    attemptId: attempt.id,
    communicationId: attempt.communicationId,
    kind: "automatic",
    result: "projected",
    classification,
    eventKey: `delivery:${evidence.id}:projection:${classification}:projected`,
  });
  return "projected" as const;
}

async function processEvidence(
  tx: Database,
  evidence: DeliveryEvidence,
  override?: SmsDeliveryClassification,
) {
  const attribution = await attributeEvidence(tx, evidence);
  if (attribution.result !== "attributed") return attribution.result;
  return projectEvidence(
    tx,
    evidence,
    attribution.attempt,
    override ?? evidence.classification,
  );
}

/**
 * Closes the callback-first race inside the accepted send transaction. If a
 * callback committed first, the newly inserted accepted attempt evidence can
 * immediately attribute and project it. If acceptance commits first, the
 * callback path sees it normally.
 */
export async function processPendingDeliveryEvidenceForAcceptedSend(
  tx: Database,
  provider: string,
  providerMessageId: string,
  options: { identityLockHeld?: boolean } = {},
) {
  if (provider !== "telnyx" && provider !== "twilio") return [];
  if (!options.identityLockHeld) {
    await lockSmsDeliveryIdentity(tx, provider, providerMessageId);
  }
  const evidenceRows = await tx
    .select()
    .from(smsDeliveryEvents)
    .where(
      and(
        eq(smsDeliveryEvents.provider, provider),
        eq(smsDeliveryEvents.providerMessageId, providerMessageId),
      ),
    )
    .orderBy(smsDeliveryEvents.receivedAt, smsDeliveryEvents.id)
    .limit(SMS_DELIVERY_ACCEPTED_SWEEP_LIMIT);

  const results = [];
  for (const evidence of evidenceRows) {
    results.push(await processEvidence(tx, evidence));
  }
  return results;
}

export async function recordSmsDeliveryCallback(input: {
  provider: SmsDeliveryProvider;
  providerEventId?: string | null;
  providerMessageId?: string | null;
  providerEventType: string;
  providerStatus?: string | null;
  providerErrorCode?: string | null;
  classification: SmsDeliveryClassification;
  occurredAt?: Date | null;
}) {
  const providerEventId = bounded(input.providerEventId, 255);
  const providerMessageId = bounded(input.providerMessageId, 255);
  const providerEventType =
    redactedProviderToken(input.providerEventType) ?? "unknown";
  const providerStatus = redactedProviderToken(input.providerStatus);
  const providerErrorCode = redactedProviderToken(input.providerErrorCode);
  const fingerprint = smsDeliveryFingerprint({
    provider: input.provider,
    providerEventId,
    providerMessageId,
    providerEventType,
    providerStatus,
    providerErrorCode,
    occurredAt: input.occurredAt,
  });
  const eventKey = eventIdentity({ providerEventId, fingerprint });

  return withSystem(db, async (tx) => {
    await lockSmsDeliveryIdentity(
      tx as unknown as Database,
      input.provider,
      providerMessageId,
    );
    const [inserted] = await tx
      .insert(smsDeliveryEvents)
      .values({
        provider: input.provider,
        providerEventId,
        providerMessageId,
        providerEventType,
        providerStatus,
        providerErrorCode,
        classification: input.classification,
        occurredAt: input.occurredAt,
        eventKey,
        payloadFingerprintSha256: fingerprint,
      })
      .onConflictDoNothing({
        target: [smsDeliveryEvents.provider, smsDeliveryEvents.eventKey],
      })
      .returning();

    const [evidence] = inserted
      ? [inserted]
      : await tx
          .select()
          .from(smsDeliveryEvents)
          .where(
            and(
              eq(smsDeliveryEvents.provider, input.provider),
              eq(smsDeliveryEvents.eventKey, eventKey),
            ),
          )
          .limit(1);
    if (!evidence) {
      throw new Error("SMS delivery evidence could not be persisted.");
    }

    if (!inserted && evidence.payloadFingerprintSha256 !== fingerprint) {
      await appendHistory(tx as unknown as Database, {
        deliveryEventId: evidence.id,
        kind: "automatic",
        result: "ambiguous",
        classification: input.classification,
        detail: conflictingObservationDetail({
          fingerprint,
          providerMessageId,
          providerEventType,
          providerStatus,
          providerErrorCode,
          occurredAt: input.occurredAt,
          messageIdDiffers: evidence.providerMessageId !== providerMessageId,
        }),
        eventKey: `delivery:${evidence.id}:identity-conflict:${fingerprint}`,
      });
      return {
        eventId: evidence.id,
        duplicate: true,
        result: "ambiguous" as const,
      };
    }

    const result = await processEvidence(tx as unknown as Database, evidence);
    return { eventId: evidence.id, duplicate: !inserted, result };
  });
}

export async function reconcileSmsDeliveryEvent(input: {
  deliveryEventId: string;
  reconciliationId: string;
  reviewedHistoryId?: string;
  classification?: Exclude<SmsDeliveryClassification, "unknown">;
  reasonCode: SmsDeliveryReconciliationReason;
  actorIdentity: string;
  actorName: string;
}) {
  const actorIdentity = bounded(input.actorIdentity, 255);
  const actorName = bounded(input.actorName, 255);
  if (!actorIdentity || !actorName) {
    throw new Error("Complete bounded reconciliation evidence is required.");
  }
  if (
    (input.reasonCode === "provider_portal_status_review") !==
    Boolean(input.classification)
  ) {
    throw new Error(
      "Only a provider-portal status review may record a reviewed classification.",
    );
  }

  return withSystem(db, async (tx) => {
    const [evidence] = await tx
      .select()
      .from(smsDeliveryEvents)
      .where(eq(smsDeliveryEvents.id, input.deliveryEventId))
      .limit(1);
    if (!evidence) throw new Error("SMS delivery evidence not found.");

    if (evidence.providerMessageId) {
      await lockSmsDeliveryIdentity(
        tx as unknown as Database,
        evidence.provider,
        evidence.providerMessageId,
      );
    } else {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`sms-delivery-event:${evidence.id}`}, 0))`,
      );
    }

    const operatorEventKey = `delivery:${evidence.id}:operator-reconciliation:${input.reconciliationId}`;
    const [priorAction] = await tx
      .select()
      .from(smsDeliveryEventHistory)
      .where(eq(smsDeliveryEventHistory.eventKey, operatorEventKey))
      .limit(1);
    if (priorAction?.result === "operator_reviewed") {
      if (
        priorAction.deliveryEventId !== evidence.id ||
        priorAction.reviewedHistoryId !== input.reviewedHistoryId ||
        priorAction.classification !== evidence.classification ||
        priorAction.operatorReasonCode !== input.reasonCode ||
        priorAction.actorIdentity !== actorIdentity ||
        priorAction.actorName !== actorName ||
        input.classification
      ) {
        throw new Error("Reconciliation id collision; nothing was changed.");
      }
      return {
        eventId: evidence.id,
        classification: evidence.classification,
        result:
          input.reasonCode === "identity_conflict_review"
            ? ("identity_conflict_reviewed" as const)
            : ("unmatched_evidence_reviewed" as const),
      };
    }
    const requestedClassificationDetail = input.classification
      ? `requested_classification:${input.classification}`
      : "requested_classification:derived";
    if (priorAction) {
      if (
        priorAction.result !== "reconciled" ||
        priorAction.deliveryEventId !== evidence.id ||
        priorAction.reviewedHistoryId ||
        priorAction.operatorReasonCode !== input.reasonCode ||
        priorAction.actorIdentity !== actorIdentity ||
        priorAction.actorName !== actorName ||
        priorAction.detail !== requestedClassificationDetail
      ) {
        throw new Error("Reconciliation id collision; nothing was changed.");
      }
      const attribution = await attributeEvidence(
        tx as unknown as Database,
        evidence,
      );
      if (attribution.result !== "attributed") {
        return {
          eventId: evidence.id,
          classification: priorAction.classification,
          result: attribution.result,
        };
      }
      if (
        priorAction.practiceId !== attribution.attempt.practiceId ||
        priorAction.attemptId !== attribution.attempt.id ||
        priorAction.communicationId !== attribution.attempt.communicationId
      ) {
        throw new Error("Reconciliation id collision; nothing was changed.");
      }
      const result = await projectEvidence(
        tx as unknown as Database,
        evidence,
        attribution.attempt,
        priorAction.classification,
      );
      return {
        eventId: evidence.id,
        attemptId: attribution.attempt.id,
        practiceId: attribution.attempt.practiceId,
        classification: priorAction.classification,
        result,
      };
    }
    const appendOperatorReview = async () => {
      const [inserted] = await tx
        .insert(smsDeliveryEventHistory)
        .values({
          deliveryEventId: evidence.id,
          reviewedHistoryId: input.reviewedHistoryId,
          kind: "operator_reconciliation",
          result: "operator_reviewed",
          classification: evidence.classification,
          operatorReasonCode: input.reasonCode,
          actorType: "platform_operator",
          actorIdentity,
          actorName,
          eventKey: operatorEventKey,
          createdAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        const [prior] = await tx
          .select()
          .from(smsDeliveryEventHistory)
          .where(eq(smsDeliveryEventHistory.eventKey, operatorEventKey))
          .limit(1);
        if (
          !prior ||
          prior.deliveryEventId !== evidence.id ||
          prior.reviewedHistoryId !== input.reviewedHistoryId ||
          prior.result !== "operator_reviewed" ||
          prior.classification !== evidence.classification ||
          prior.operatorReasonCode !== input.reasonCode ||
          prior.actorIdentity !== actorIdentity ||
          prior.actorName !== actorName
        ) {
          throw new Error("Reconciliation id collision; nothing was changed.");
        }
      }
    };

    if (input.reasonCode === "identity_conflict_review") {
      if (input.classification) {
        throw new Error("Identity-conflict review cannot project a status.");
      }
      if (!input.reviewedHistoryId) {
        throw new Error(
          "Identity-conflict review requires its exact history id.",
        );
      }
      const [pendingConflict] = await tx
        .select({ id: smsDeliveryEventHistory.id })
        .from(smsDeliveryEventHistory)
        .where(
          and(
            eq(smsDeliveryEventHistory.id, input.reviewedHistoryId),
            eq(smsDeliveryEventHistory.deliveryEventId, evidence.id),
            eq(smsDeliveryEventHistory.result, "ambiguous"),
            sql`not exists (
              select 1
              from sms_delivery_event_history reviewed_conflict
              where reviewed_conflict.reviewed_history_id = ${smsDeliveryEventHistory.id}
            )`,
          ),
        )
        .orderBy(smsDeliveryEventHistory.createdAt, smsDeliveryEventHistory.id)
        .limit(1);
      if (!pendingConflict) {
        throw new Error("No pending provider identity conflict exists.");
      }
      await appendOperatorReview();
      return {
        eventId: evidence.id,
        classification: evidence.classification,
        result: "identity_conflict_reviewed" as const,
      };
    }

    const attribution = await attributeEvidence(
      tx as unknown as Database,
      evidence,
    );
    if (attribution.result !== "attributed") {
      if (
        input.classification ||
        input.reasonCode !== "unmatched_evidence_review" ||
        !input.reviewedHistoryId
      ) {
        throw new Error(
          "Unresolved evidence may only receive its matching quarantine review; it cannot project a status.",
        );
      }
      const [pendingUnresolved] = await tx
        .select({ id: smsDeliveryEventHistory.id })
        .from(smsDeliveryEventHistory)
        .where(
          and(
            eq(smsDeliveryEventHistory.id, input.reviewedHistoryId),
            eq(smsDeliveryEventHistory.deliveryEventId, evidence.id),
            eq(smsDeliveryEventHistory.result, "unmatched"),
            sql`not exists (
              select 1
              from sms_delivery_event_history reviewed_unresolved
              where reviewed_unresolved.reviewed_history_id = ${smsDeliveryEventHistory.id}
            )`,
          ),
        )
        .limit(1);
      if (!pendingUnresolved) {
        throw new Error(
          "The unresolved history row is missing or already reviewed.",
        );
      }
      await appendOperatorReview();
      return {
        eventId: evidence.id,
        classification: evidence.classification,
        result: "unmatched_evidence_reviewed" as const,
      };
    }

    if (input.reasonCode === "unmatched_evidence_review") {
      throw new Error(
        "Quarantine review reasons apply only while evidence is unresolved.",
      );
    }
    if (input.reviewedHistoryId) {
      throw new Error(
        "Exact delivery reconciliation cannot review quarantine history.",
      );
    }

    const [latestReconciliation] = await tx
      .select({ classification: smsDeliveryEventHistory.classification })
      .from(smsDeliveryEventHistory)
      .where(
        and(
          eq(smsDeliveryEventHistory.deliveryEventId, evidence.id),
          eq(
            smsDeliveryEventHistory.practiceId,
            attribution.attempt.practiceId,
          ),
          eq(smsDeliveryEventHistory.attemptId, attribution.attempt.id),
          eq(smsDeliveryEventHistory.result, "reconciled"),
        ),
      )
      .orderBy(
        desc(smsDeliveryEventHistory.createdAt),
        desc(smsDeliveryEventHistory.id),
      )
      .limit(1);
    const currentClassification =
      latestReconciliation?.classification ?? evidence.classification;
    const classification = input.classification
      ? reduceSmsDeliveryStatus(currentClassification, input.classification)
      : currentClassification;
    const eventKey = operatorEventKey;
    const [inserted] = await tx
      .insert(smsDeliveryEventHistory)
      .values({
        deliveryEventId: evidence.id,
        practiceId: attribution.attempt.practiceId,
        attemptId: attribution.attempt.id,
        communicationId: attribution.attempt.communicationId,
        kind: "operator_reconciliation",
        result: "reconciled",
        classification,
        detail: requestedClassificationDetail,
        operatorReasonCode: input.reasonCode,
        actorType: "platform_operator",
        actorIdentity,
        actorName,
        eventKey,
        createdAt: sql`clock_timestamp()`,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [prior] = await tx
        .select()
        .from(smsDeliveryEventHistory)
        .where(eq(smsDeliveryEventHistory.eventKey, eventKey))
        .limit(1);
      if (
        !prior ||
        prior.deliveryEventId !== evidence.id ||
        prior.practiceId !== attribution.attempt.practiceId ||
        prior.attemptId !== attribution.attempt.id ||
        prior.communicationId !== attribution.attempt.communicationId ||
        prior.result !== "reconciled" ||
        prior.classification !== classification ||
        prior.operatorReasonCode !== input.reasonCode ||
        prior.actorIdentity !== actorIdentity ||
        prior.actorName !== actorName
      ) {
        throw new Error("Reconciliation id collision; nothing was changed.");
      }
    }

    const result = await projectEvidence(
      tx as unknown as Database,
      evidence,
      attribution.attempt,
      classification,
    );
    return {
      eventId: evidence.id,
      attemptId: attribution.attempt.id,
      practiceId: attribution.attempt.practiceId,
      classification,
      result,
    };
  });
}
