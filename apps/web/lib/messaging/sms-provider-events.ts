import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  locationMessaging,
  messagingRegistrationEvents,
  messagingRegistrations,
  practices,
  smsProviderEventConflicts,
  smsProviderEvents,
  smsSendAttemptEvents,
  smsSendAttempts,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { envFlagEnabled } from "@/lib/env-bool";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";
import { mergeRegistrationStatus } from "./a2p-lifecycle";
import {
  findMessagingLocationCandidatesForWebhookInTransaction,
  lockMessagingLocationIdentityInTransaction,
  type InboundSmsClassification,
  type InboundSmsProvider,
} from "./inbound";
import { normalizeE164 } from "./phone";
import {
  recordMessagingRegistrationEvent,
  systemMessagingRegistrationActor,
} from "./registration-events";
import {
  lockSmsDeliveryIdentity,
  recordSmsDeliveryCallbackInTransaction,
} from "./sms-delivery-ledger";
import { acquireSmsRecipientLockInTransaction } from "./suppression";
import { smsProviderEventQuarantineIsRemediatedSql } from "./sms-provider-event-resolution-status";

const MAX_IDENTIFIER_LENGTH = 255;
const MAX_EVENT_TYPE_LENGTH = 80;
const MAX_MESSAGE_BODY_LENGTH = 1_600;
const MAX_PROFILE_IDENTIFIER_LENGTH = 128;
const MAX_PROVIDER_DETAIL_LENGTH = 1_000;
const MAX_OCCURRED_AT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_OCCURRED_AT_FUTURE_MS = 10 * 60 * 1_000;
const MAX_PROJECTION_ATTEMPTS = 12;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]+$/;

type SmsProviderEventBase = {
  provider: InboundSmsProvider;
  providerEventId?: string | null;
  providerEventType: string;
  rawBody: string;
  occurredAt?: Date | string | null;
  receivedAt?: Date;
};

export type NormalizedSmsProviderEventInput =
  | (SmsProviderEventBase & {
      kind: "inbound";
      providerMessageId: string;
      fromE164: string;
      toE164?: string | null;
      messagingProfileId?: string | null;
      messageBody: string;
      inboundClassification: InboundSmsClassification;
    })
  | (SmsProviderEventBase & {
      kind: "delivery";
      providerMessageId: string;
      deliveryClassification: "unknown" | "sent" | "failed" | "delivered";
      providerStatus?: string | null;
      providerErrorCode?: string | null;
    })
  | (SmsProviderEventBase & {
      provider: "telnyx";
      kind: "a2p";
      providerEventId?: string | null;
      a2pBrandId?: string | null;
      a2pCampaignId?: string | null;
      a2pPhoneE164?: string | null;
      a2pStatus?: string | null;
      a2pType?: string | null;
      a2pEventType?: string | null;
      a2pObservedStatus: "pending" | "action_required" | "failed" | "suspended";
      providerStatus?: string | null;
      providerDetail?: string | null;
    });

export type SmsProviderEventProjectionOutcome =
  | "projected"
  | "ignored"
  | "blocked_recovery"
  | "retry"
  | "quarantined"
  | "already_terminal"
  | "not_found";

export type SmsProviderEventBatchResult = {
  claimed: number;
  projected: number;
  ignored: number;
  blockedRecovery: number;
  retried: number;
  quarantined: number;
  remaining: number;
  budgetExhausted: boolean;
};

export type SmsProviderEventBacklogSummary = {
  pending: number;
  retry: number;
  blockedRecovery: number;
  quarantined: number;
  conflicts: number;
  oldestUnresolvedAt: Date | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_IDENTIFIER_LENGTH) return null;
  return trimmed;
}

function requiredIdentifier(value: string, label: string): string {
  const bounded = boundedIdentifier(value);
  if (!bounded) throw new Error(`${label} is missing or exceeds its limit`);
  return bounded;
}

function boundedProfileIdentifier(
  value: string | null | undefined,
  label: string,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_PROFILE_IDENTIFIER_LENGTH) {
    throw new Error(`${label} exceeds its limit`);
  }
  return trimmed;
}

function boundedDetail(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_PROVIDER_DETAIL_LENGTH) : null;
}

function safeToken(
  value: string | null | undefined,
  maxLength: number,
  label: string,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength || !SAFE_TOKEN.test(trimmed)) {
    throw new Error(`${label} is not a bounded provider token`);
  }
  return trimmed;
}

function eventKeyFor(
  providerEventId: string | null,
  fingerprint: string,
): string {
  if (!providerEventId) return `body:${fingerprint}`;
  const direct = `id:${providerEventId}`;
  return direct.length <= MAX_IDENTIFIER_LENGTH
    ? direct
    : `id-sha256:${sha256(providerEventId)}`;
}

/**
 * Provider time is evidence only inside a narrow, plausible envelope. An
 * invalid/future/ancient signed value falls back to receipt time so it cannot
 * hide an inbox item or dominate consent ordering indefinitely.
 */
export function normalizeProviderOccurredAt(
  value: Date | string | null | undefined,
  receivedAt: Date,
): Date {
  const parsed = value instanceof Date ? value : value ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) return receivedAt;
  const delta = parsed.getTime() - receivedAt.getTime();
  if (delta > MAX_OCCURRED_AT_FUTURE_MS || delta < -MAX_OCCURRED_AT_AGE_MS) {
    return receivedAt;
  }
  return parsed;
}

function valuesForInsert(input: NormalizedSmsProviderEventInput) {
  const receivedAt = input.receivedAt ?? new Date();
  if (!Number.isFinite(receivedAt.getTime())) {
    throw new Error("Provider event receivedAt is invalid");
  }
  const providerEventType = safeToken(
    input.providerEventType,
    MAX_EVENT_TYPE_LENGTH,
    "providerEventType",
  );
  if (!providerEventType) throw new Error("providerEventType is required");
  const providerEventId = boundedIdentifier(input.providerEventId);
  if (input.providerEventId && !providerEventId) {
    throw new Error("providerEventId exceeds its limit");
  }
  const fingerprint = sha256(input.rawBody);
  const common = {
    receivedAt,
    provider: input.provider,
    kind: input.kind,
    providerEventId,
    providerEventType,
    eventKey: eventKeyFor(providerEventId, fingerprint),
    rawBodyFingerprintSha256: fingerprint,
    occurredAt: normalizeProviderOccurredAt(input.occurredAt, receivedAt),
  };

  if (input.kind === "inbound") {
    const fromE164 = normalizeE164(input.fromE164);
    const toE164 = input.toE164 ? normalizeE164(input.toE164) : null;
    if (!fromE164 || (input.toE164 && !toE164)) {
      throw new Error("Inbound SMS has an invalid sender identity");
    }
    const messageBody = input.messageBody.trim();
    if (!messageBody || messageBody.length > MAX_MESSAGE_BODY_LENGTH) {
      throw new Error("Inbound SMS body exceeds its durable inbox limit");
    }
    const messagingProfileId = boundedProfileIdentifier(
      input.messagingProfileId,
      "messagingProfileId",
    );
    return {
      ...common,
      kind: "inbound" as const,
      providerMessageId: requiredIdentifier(
        input.providerMessageId,
        "providerMessageId",
      ),
      fromE164,
      toE164,
      messagingProfileId,
      messageBody,
      inboundClassification: input.inboundClassification,
    };
  }
  if (input.kind === "delivery") {
    return {
      ...common,
      kind: "delivery" as const,
      providerMessageId: requiredIdentifier(
        input.providerMessageId,
        "providerMessageId",
      ),
      deliveryClassification: input.deliveryClassification,
      providerStatus: safeToken(
        input.providerStatus,
        MAX_EVENT_TYPE_LENGTH,
        "providerStatus",
      ),
      providerErrorCode: safeToken(
        input.providerErrorCode,
        MAX_EVENT_TYPE_LENGTH,
        "providerErrorCode",
      ),
    };
  }
  const a2pBrandId = boundedProfileIdentifier(input.a2pBrandId, "a2pBrandId");
  const a2pCampaignId = boundedProfileIdentifier(
    input.a2pCampaignId,
    "a2pCampaignId",
  );
  const a2pPhoneE164 = input.a2pPhoneE164
    ? normalizeE164(input.a2pPhoneE164)
    : null;
  if (input.a2pPhoneE164 && !a2pPhoneE164) {
    throw new Error("A2P provider event has an invalid phone identity");
  }
  if (!a2pBrandId && !a2pCampaignId && !a2pPhoneE164) {
    throw new Error("A2P provider event has no resolvable identity");
  }
  return {
    ...common,
    kind: "a2p" as const,
    provider: "telnyx" as const,
    a2pBrandId,
    a2pCampaignId,
    a2pPhoneE164,
    a2pStatus: safeToken(input.a2pStatus, 80, "a2pStatus"),
    a2pType: safeToken(input.a2pType, 80, "a2pType"),
    a2pEventType: safeToken(input.a2pEventType, 80, "a2pEventType"),
    a2pObservedStatus: input.a2pObservedStatus,
    providerStatus: safeToken(
      input.providerStatus,
      MAX_EVENT_TYPE_LENGTH,
      "providerStatus",
    ),
    providerDetail: boundedDetail(input.providerDetail),
  };
}

export type IngestSmsProviderEventResult = {
  eventId: string;
  duplicate: boolean;
  conflict: boolean;
};

type IntakeResolution = {
  practiceIds: string[];
  attribution: { practiceId: string; locationId: string | null } | null;
};

function sameResolution(a: IntakeResolution, b: IntakeResolution): boolean {
  return (
    a.practiceIds.join("|") === b.practiceIds.join("|") &&
    a.attribution?.practiceId === b.attribution?.practiceId &&
    a.attribution?.locationId === b.attribution?.locationId
  );
}

async function resolveIntakeInTransaction(
  tx: Database,
  values: ReturnType<typeof valuesForInsert>,
): Promise<IntakeResolution> {
  if (values.kind === "inbound") {
    const candidates =
      await findMessagingLocationCandidatesForWebhookInTransaction(tx, {
        provider: values.provider,
        senderE164: values.toE164,
        messagingProfileId: values.messagingProfileId,
      });
    return {
      practiceIds: candidates.practiceIds,
      attribution: candidates.location,
    };
  }

  if (values.kind === "delivery") {
    const attempts = await tx
      .select({
        id: smsSendAttempts.id,
        practiceId: smsSendAttempts.practiceId,
        locationId: smsSendAttempts.locationId,
      })
      .from(smsSendAttempts)
      .innerJoin(
        smsSendAttemptEvents,
        and(
          eq(smsSendAttemptEvents.practiceId, smsSendAttempts.practiceId),
          eq(smsSendAttemptEvents.attemptId, smsSendAttempts.id),
          eq(smsSendAttemptEvents.outcome, "accepted"),
          eq(smsSendAttemptEvents.providerMessageId, values.providerMessageId),
        ),
      )
      .where(eq(smsSendAttempts.provider, values.provider))
      .groupBy(
        smsSendAttempts.id,
        smsSendAttempts.practiceId,
        smsSendAttempts.locationId,
      )
      .orderBy(smsSendAttempts.practiceId, smsSendAttempts.id)
      .limit(100);
    const practiceIds = [
      ...new Set(attempts.map((attempt) => attempt.practiceId)),
    ].sort();
    return {
      practiceIds,
      attribution:
        attempts.length === 1
          ? {
              practiceId: attempts[0]!.practiceId,
              locationId: attempts[0]!.locationId,
            }
          : null,
    };
  }

  const brandMatches = values.a2pBrandId
    ? await tx
        .select({ practiceId: messagingRegistrations.practiceId })
        .from(messagingRegistrations)
        .where(
          and(
            eq(messagingRegistrations.providerBrandId, values.a2pBrandId),
            isNull(messagingRegistrations.deletedAt),
          ),
        )
        .limit(2)
    : [];
  const campaignMatches = values.a2pCampaignId
    ? await tx
        .select({ practiceId: messagingRegistrations.practiceId })
        .from(messagingRegistrations)
        .where(
          and(
            eq(messagingRegistrations.providerCampaignId, values.a2pCampaignId),
            isNull(messagingRegistrations.deletedAt),
          ),
        )
        .limit(2)
    : [];
  const senderMatches = values.a2pPhoneE164
    ? await tx
        .select({
          practiceId: locationMessaging.practiceId,
          locationId: locationMessaging.locationId,
        })
        .from(locationMessaging)
        .where(
          and(
            eq(locationMessaging.provider, "telnyx"),
            eq(locationMessaging.senderE164, values.a2pPhoneE164),
            isNull(locationMessaging.deletedAt),
          ),
        )
        .limit(2)
    : [];
  const phoneRegistrationMatches =
    senderMatches.length === 1
      ? await tx
          .select({ practiceId: messagingRegistrations.practiceId })
          .from(messagingRegistrations)
          .where(
            and(
              eq(
                messagingRegistrations.practiceId,
                senderMatches[0]!.practiceId,
              ),
              isNull(messagingRegistrations.deletedAt),
            ),
          )
          .limit(2)
      : [];
  const practiceIds = [
    ...new Set(
      [
        ...brandMatches,
        ...campaignMatches,
        ...phoneRegistrationMatches,
        ...senderMatches,
      ].map((match) => match.practiceId),
    ),
  ].sort();
  const resolutionCounts = [
    ...(values.a2pBrandId ? [brandMatches.length] : []),
    ...(values.a2pCampaignId ? [campaignMatches.length] : []),
    ...(values.a2pPhoneE164
      ? [senderMatches.length, phoneRegistrationMatches.length]
      : []),
  ];
  const exact =
    resolutionCounts.length > 0 &&
    resolutionCounts.every((count) => count === 1) &&
    practiceIds.length === 1;
  return {
    practiceIds,
    attribution: exact
      ? {
          practiceId: practiceIds[0]!,
          locationId:
            senderMatches.length === 1 ? senderMatches[0]!.locationId : null,
        }
      : null,
  };
}

async function lockPracticeIdsInTransaction(
  tx: Database,
  practiceIds: string[],
): Promise<void> {
  if (practiceIds.length === 0) return;
  const locked = await tx
    .select({ id: practices.id })
    .from(practices)
    .where(
      and(
        inArray(practices.id, [...practiceIds].sort()),
        isNull(practices.deletedAt),
      ),
    )
    .orderBy(practices.id)
    .for("share", { of: practices });
  if (locked.length !== practiceIds.length) {
    throw new Error("Provider event tenant changed during intake");
  }
}

/** Insert before ACK. Exact signed replays are idempotent; identity reuse with
 * a different signed body appends conflict evidence and quarantines projection. */
export async function ingestSmsProviderEvent(
  input: NormalizedSmsProviderEventInput,
): Promise<IngestSmsProviderEventResult> {
  const normalizedValues = valuesForInsert(input);
  return withSystem(db, async (tx) => {
    const [preExisting] = await tx
      .select({
        id: smsProviderEvents.id,
        practiceId: smsProviderEvents.practiceId,
      })
      .from(smsProviderEvents)
      .where(
        and(
          eq(smsProviderEvents.provider, normalizedValues.provider),
          eq(smsProviderEvents.eventKey, normalizedValues.eventKey),
        ),
      )
      .limit(1);
    const initialResolution = await resolveIntakeInTransaction(
      tx,
      normalizedValues,
    );
    const lockedPracticeIds = [
      ...new Set([
        ...initialResolution.practiceIds,
        ...(preExisting?.practiceId ? [preExisting.practiceId] : []),
      ]),
    ].sort();
    await lockPracticeIdsInTransaction(tx, lockedPracticeIds);
    if (
      normalizedValues.kind === "inbound" &&
      initialResolution.attribution &&
      !(await lockMessagingLocationIdentityInTransaction(tx, {
        provider: normalizedValues.provider,
        practiceId: initialResolution.attribution.practiceId,
        locationId: initialResolution.attribution.locationId!,
        senderE164: normalizedValues.toE164,
        messagingProfileId: normalizedValues.messagingProfileId,
      }))
    ) {
      throw new Error("Provider sender identity changed during intake");
    }
    const resolution = await resolveIntakeInTransaction(tx, normalizedValues);
    if (!sameResolution(initialResolution, resolution)) {
      throw new Error("Provider event tenant changed during intake");
    }
    if (normalizedValues.kind === "inbound") {
      for (const practiceId of initialResolution.practiceIds) {
        await acquireSmsRecipientLockInTransaction(
          tx,
          practiceId,
          normalizedValues.fromE164,
        );
      }
    }
    const [existingAfterLocks] = await tx
      .select({
        id: smsProviderEvents.id,
        practiceId: smsProviderEvents.practiceId,
      })
      .from(smsProviderEvents)
      .where(
        and(
          eq(smsProviderEvents.provider, normalizedValues.provider),
          eq(smsProviderEvents.eventKey, normalizedValues.eventKey),
        ),
      )
      .limit(1);
    if (
      (preExisting &&
        (!existingAfterLocks ||
          existingAfterLocks.id !== preExisting.id ||
          existingAfterLocks.practiceId !== preExisting.practiceId)) ||
      (existingAfterLocks?.practiceId &&
        !lockedPracticeIds.includes(existingAfterLocks.practiceId))
    ) {
      // A concurrent first insert resolved this identity to a practice not yet
      // locked. Fail the request so provider retry can acquire the full sorted
      // practice union; never append a later out-of-order practice lock.
      throw new Error("Provider event identity changed during intake");
    }
    const values = {
      ...normalizedValues,
      practiceId: resolution.attribution?.practiceId ?? null,
      locationId: resolution.attribution?.locationId ?? null,
    };
    const [inserted] = await tx
      .insert(smsProviderEvents)
      .values(values)
      .onConflictDoNothing({
        target: [smsProviderEvents.provider, smsProviderEvents.eventKey],
      })
      .returning({ id: smsProviderEvents.id });
    if (inserted) {
      return { eventId: inserted.id, duplicate: false, conflict: false };
    }

    const [candidate] = await tx
      .select({
        id: smsProviderEvents.id,
        practiceId: smsProviderEvents.practiceId,
        fingerprint: smsProviderEvents.rawBodyFingerprintSha256,
      })
      .from(smsProviderEvents)
      .where(
        and(
          eq(smsProviderEvents.provider, values.provider),
          eq(smsProviderEvents.eventKey, values.eventKey),
        ),
      )
      .limit(1);
    if (!candidate) throw new Error("Provider event conflict row disappeared");
    if (
      candidate.practiceId &&
      !lockedPracticeIds.includes(candidate.practiceId)
    ) {
      throw new Error("Provider event identity changed during intake");
    }
    if (candidate.fingerprint === values.rawBodyFingerprintSha256) {
      return { eventId: candidate.id, duplicate: true, conflict: false };
    }

    const [original] = await tx
      .select({
        id: smsProviderEvents.id,
        state: smsProviderEvents.state,
        fingerprint: smsProviderEvents.rawBodyFingerprintSha256,
      })
      .from(smsProviderEvents)
      .where(eq(smsProviderEvents.id, candidate.id))
      .limit(1)
      .for("update");
    if (!original) throw new Error("Provider event conflict row disappeared");
    if (original.fingerprint === values.rawBodyFingerprintSha256) {
      return { eventId: original.id, duplicate: true, conflict: false };
    }

    await tx
      .insert(smsProviderEventConflicts)
      .values({
        originalEventId: original.id,
        incomingRawBodyFingerprintSha256: values.rawBodyFingerprintSha256,
        incomingProviderEventType: values.providerEventType,
        incomingProviderEventId: values.providerEventId,
        incomingProviderMessageId:
          "providerMessageId" in values ? values.providerMessageId : null,
      })
      .onConflictDoNothing({
        target: [
          smsProviderEventConflicts.originalEventId,
          smsProviderEventConflicts.incomingRawBodyFingerprintSha256,
        ],
      });
    const now = new Date();
    if (
      original.state === "pending" ||
      original.state === "retry" ||
      original.state === "blocked_recovery"
    ) {
      await tx
        .update(smsProviderEvents)
        .set({
          state: "quarantined",
          attemptCount: sql`greatest(${smsProviderEvents.attemptCount} + 1, 1)`,
          nextAttemptAt: null,
          lastAttemptAt: now,
          processedAt: now,
          lastErrorCode: "provider_identity_conflict",
          lastErrorDetail:
            "Provider reused an event identity for a different signed body.",
        })
        .where(
          and(
            eq(smsProviderEvents.id, original.id),
            inArray(smsProviderEvents.state, [
              "pending",
              "retry",
              "blocked_recovery",
            ]),
          ),
        );
    }
    return { eventId: original.id, duplicate: false, conflict: true };
  });
}

export type StoredSmsProviderEvent = typeof smsProviderEvents.$inferSelect;

export type LockedSmsProviderEventRemediation = {
  event: StoredSmsProviderEvent;
  attribution: { practiceId: string; locationId: string | null } | null;
  resolution: IntakeResolution;
  inboundRecipientLockHeld: boolean;
};

function hostedInboundProjectionEnabled(): boolean {
  return (
    !envFlagEnabled("HOSTED_BILLING_ENABLED") ||
    envFlagEnabled("MESSAGING_INBOUND_ENABLED")
  );
}

async function lockPracticeStatesInTransaction(
  tx: Database,
  practiceIds: string[],
  options: { forUpdate?: boolean } = {},
): Promise<Map<string, boolean>> {
  if (practiceIds.length === 0) return new Map();
  const sorted = [...new Set(practiceIds)].sort();
  const rows = await tx
    .select({ id: practices.id, recoveryHold: practices.recoveryHold })
    .from(practices)
    .where(and(inArray(practices.id, sorted), isNull(practices.deletedAt)))
    .orderBy(practices.id)
    .for(options.forUpdate ? "update" : "share", { of: practices });
  if (rows.length !== sorted.length) {
    throw new Error("Provider event tenant changed before projection");
  }
  return new Map(rows.map((row) => [row.id, row.recoveryHold]));
}

async function lockAllProviderPracticeStatesInTransaction(
  tx: Database,
  provider: InboundSmsProvider,
): Promise<Map<string, boolean>> {
  const rows = await tx
    .select({ id: practices.id, recoveryHold: practices.recoveryHold })
    .from(practices)
    .where(
      and(
        isNull(practices.deletedAt),
        sql`(
          exists (
            select 1
            from location_messaging sender
            where sender.practice_id = ${practices.id}
              and sender.provider = ${provider}
              and sender.deleted_at is null
          )
          or exists (
            select 1
            from sms_send_attempts attempt
            where attempt.practice_id = ${practices.id}
              and attempt.provider = ${provider}
          )
        )`,
      ),
    )
    .orderBy(practices.id)
    .for("update", { of: practices });
  return new Map(rows.map((row) => [row.id, row.recoveryHold]));
}

/**
 * Lock and revalidate a terminal provider event for audited remediation. The
 * event remains immutable; callers may only append durable resolution evidence
 * in this same transaction. Inbound work follows the intake-compatible order:
 * practice, exact sender identity, recipient advisory, then event row.
 */
export async function lockSmsProviderEventForRemediationInTransaction(
  tx: Database,
  eventId: string,
  options: {
    lockedPracticeId?: string;
    allowGloballyUnattributedDelivery?: boolean;
    allowImmutableInboundOptOut?: boolean;
    allowRecoveryHeld?: boolean;
  } = {},
): Promise<LockedSmsProviderEventRemediation> {
  const [peek] = await tx
    .select()
    .from(smsProviderEvents)
    .where(eq(smsProviderEvents.id, eventId))
    .limit(1);
  if (!peek) throw new Error("SMS provider event not found.");
  if (!terminalState(peek.state)) {
    throw new Error("Only terminal provider events may be remediated.");
  }

  const initialResolution = await resolveStoredEventInTransaction(tx, peek);
  const practiceIds = [
    ...new Set([
      ...initialResolution.practiceIds,
      ...(peek.practiceId ? [peek.practiceId] : []),
    ]),
  ].sort();
  const globalDeliveryNoProjectionCandidate =
    options.allowGloballyUnattributedDelivery &&
    peek.kind === "delivery" &&
    !peek.practiceId &&
    practiceIds.length === 0;
  let practiceStates: Map<string, boolean>;
  if (options.lockedPracticeId) {
    if (
      practiceIds.length !== 1 ||
      practiceIds[0] !== options.lockedPracticeId
    ) {
      throw new Error(
        "Provider event does not match the already-locked practice.",
      );
    }
    practiceStates = new Map([[options.lockedPracticeId, false]]);
  } else if (globalDeliveryNoProjectionCandidate) {
    // A provider callback that currently has no tenant may race an accepted
    // send whose provider result has not committed yet. Lock every practice
    // that can or has sent through this provider before taking the canonical
    // delivery identity lock and repeating attribution. This makes the final
    // zero-owner proof stable through resolution commit.
    practiceStates = await lockAllProviderPracticeStatesInTransaction(
      tx,
      peek.provider as InboundSmsProvider,
    );
  } else {
    practiceStates = await lockPracticeStatesInTransaction(tx, practiceIds, {
      forUpdate: true,
    });
  }
  if (
    !options.allowRecoveryHeld &&
    [...practiceStates.values()].some(Boolean)
  ) {
    throw new Error(
      "Provider event remediation is paused while the clinic is in recovery.",
    );
  }

  if (peek.kind === "delivery") {
    await lockSmsDeliveryIdentity(tx, peek.provider, peek.providerMessageId);
  }

  let inboundRecipientLockHeld = false;
  const immutableInboundOptOut =
    options.allowImmutableInboundOptOut &&
    peek.kind === "inbound" &&
    Boolean(peek.practiceId && peek.locationId && peek.fromE164);
  if (immutableInboundOptOut) {
    await acquireSmsRecipientLockInTransaction(
      tx,
      peek.practiceId!,
      peek.fromE164!,
    );
    inboundRecipientLockHeld = true;
  } else if (peek.kind === "inbound" && initialResolution.attribution) {
    const identityLocked = await lockMessagingLocationIdentityInTransaction(
      tx,
      {
        provider: peek.provider as InboundSmsProvider,
        practiceId: initialResolution.attribution.practiceId,
        locationId: initialResolution.attribution.locationId!,
        senderE164: peek.toE164,
        messagingProfileId: peek.messagingProfileId,
      },
    );
    if (!identityLocked || !peek.fromE164) {
      throw new Error(
        "Inbound provider identity changed before remediation could be locked.",
      );
    }
    await acquireSmsRecipientLockInTransaction(
      tx,
      initialResolution.attribution.practiceId,
      peek.fromE164,
    );
    inboundRecipientLockHeld = true;
  }

  const [event] = await tx
    .select()
    .from(smsProviderEvents)
    .where(eq(smsProviderEvents.id, eventId))
    .limit(1)
    .for("update");
  if (!event) throw new Error("SMS provider event not found.");
  if (!terminalState(event.state)) {
    throw new Error("Provider event state changed during remediation.");
  }
  const resolution = await resolveStoredEventInTransaction(tx, event);
  if (
    !immutableInboundOptOut &&
    !sameResolution(initialResolution, resolution)
  ) {
    throw new Error("Provider event attribution changed during remediation.");
  }
  if (
    !immutableInboundOptOut &&
    event.practiceId &&
    (!resolution.attribution ||
      resolution.attribution.practiceId !== event.practiceId ||
      (event.locationId !== null &&
        resolution.attribution.locationId !== event.locationId))
  ) {
    throw new Error(
      "Current provider identity does not match immutable event attribution.",
    );
  }
  const attribution = event.practiceId
    ? { practiceId: event.practiceId, locationId: event.locationId }
    : resolution.attribution;
  if (!attribution) {
    if (
      options.allowGloballyUnattributedDelivery &&
      event.kind === "delivery" &&
      !event.practiceId &&
      resolution.practiceIds.length === 0
    ) {
      return {
        event,
        attribution: null,
        resolution,
        inboundRecipientLockHeld,
      };
    }
    throw new Error(
      "Provider event remediation requires exact current tenant attribution.",
    );
  }
  if (event.kind === "inbound" && !attribution.locationId) {
    throw new Error(
      "Inbound provider event remediation requires an exact sender location.",
    );
  }
  return { event, attribution, resolution, inboundRecipientLockHeld };
}

async function resolveStoredEventInTransaction(
  tx: Database,
  event: StoredSmsProviderEvent,
): Promise<IntakeResolution> {
  // The schema's kind-shape constraint guarantees the fields required by each
  // discriminant. Reuse the same exact identity resolver as intake.
  return resolveIntakeInTransaction(
    tx,
    event as unknown as ReturnType<typeof valuesForInsert>,
  );
}

function terminalState(state: StoredSmsProviderEvent["state"]): boolean {
  return (
    state === "projected" || state === "ignored" || state === "quarantined"
  );
}

async function markTerminalInTransaction(
  tx: Database,
  event: StoredSmsProviderEvent,
  input: {
    state: "projected" | "ignored" | "quarantined";
    practiceId?: string | null;
    locationId?: string | null;
    errorCode?: string | null;
    errorDetail?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await tx
    .update(smsProviderEvents)
    .set({
      state: input.state,
      practiceId: event.practiceId ?? input.practiceId ?? null,
      locationId: event.locationId ?? input.locationId ?? null,
      attemptCount: sql`${smsProviderEvents.attemptCount} + 1`,
      nextAttemptAt: null,
      lastAttemptAt: now,
      processedAt: now,
      lastErrorCode:
        input.state === "quarantined"
          ? (input.errorCode ?? "provider_event_quarantined")
          : null,
      lastErrorDetail:
        input.state === "quarantined"
          ? (input.errorDetail ?? "Provider event requires operator review.")
          : null,
    })
    .where(
      and(
        eq(smsProviderEvents.id, event.id),
        eq(smsProviderEvents.state, event.state),
      ),
    );
}

async function markRetryInTransaction(
  tx: Database,
  event: StoredSmsProviderEvent,
  input: {
    practiceId?: string | null;
    locationId?: string | null;
    code: string;
    detail: string;
    exhaustible?: boolean;
  },
): Promise<"retry" | "quarantined"> {
  if (
    input.exhaustible !== false &&
    event.attemptCount + 1 >= MAX_PROJECTION_ATTEMPTS
  ) {
    await markTerminalInTransaction(tx, event, {
      state: "quarantined",
      practiceId: input.practiceId,
      locationId: input.locationId,
      errorCode: "projection_retry_exhausted",
      errorDetail: "Provider event exceeded its bounded projection attempts.",
    });
    return "quarantined";
  }
  const now = new Date();
  const delayMs = Math.min(
    60 * 60 * 1_000,
    30_000 * 2 ** Math.min(event.attemptCount, 7),
  );
  await tx
    .update(smsProviderEvents)
    .set({
      state: "retry",
      practiceId: event.practiceId ?? input.practiceId ?? null,
      locationId: event.locationId ?? input.locationId ?? null,
      attemptCount: sql`${smsProviderEvents.attemptCount} + 1`,
      nextAttemptAt: new Date(now.getTime() + delayMs),
      lastAttemptAt: now,
      processedAt: null,
      lastErrorCode: input.code,
      lastErrorDetail: input.detail,
    })
    .where(
      and(
        eq(smsProviderEvents.id, event.id),
        inArray(smsProviderEvents.state, [
          "pending",
          "retry",
          "blocked_recovery",
        ]),
      ),
    );
  return "retry";
}

async function markBlockedRecoveryInTransaction(
  tx: Database,
  event: StoredSmsProviderEvent,
  attribution: { practiceId: string; locationId: string | null },
): Promise<void> {
  const now = new Date();
  await tx
    .update(smsProviderEvents)
    .set({
      state: "blocked_recovery",
      practiceId: event.practiceId ?? attribution.practiceId,
      locationId: event.locationId ?? attribution.locationId,
      attemptCount: sql`${smsProviderEvents.attemptCount} + 1`,
      nextAttemptAt: null,
      lastAttemptAt: now,
      processedAt: null,
      lastErrorCode: "recovery_hold",
      lastErrorDetail: "Provider event projection is paused during recovery.",
    })
    .where(
      and(
        eq(smsProviderEvents.id, event.id),
        inArray(smsProviderEvents.state, ["pending", "retry"]),
      ),
    );
}

async function projectA2pEventInTransaction(
  tx: Database,
  event: StoredSmsProviderEvent,
  resolution: IntakeResolution,
): Promise<"projected" | "retry" | "quarantined"> {
  if (!resolution.attribution) {
    if (resolution.practiceIds.length === 0) return "retry";
    await tx
      .update(locationMessaging)
      .set({
        enabled: false,
        registrationStatus: "action_required",
        registrationDetail:
          "Carrier webhook identities conflict. OpenVPM must reconcile the exact brand, campaign, and number before sending can resume.",
        providerProfileReady: false,
        providerProfileSyncedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(locationMessaging.provider, "telnyx"),
          inArray(locationMessaging.practiceId, resolution.practiceIds),
          isNull(locationMessaging.deletedAt),
        ),
      );
    return "quarantined";
  }

  const registrationMatches = await tx
    .select()
    .from(messagingRegistrations)
    .where(
      and(
        eq(
          messagingRegistrations.practiceId,
          resolution.attribution.practiceId,
        ),
        isNull(messagingRegistrations.deletedAt),
        event.a2pBrandId
          ? eq(messagingRegistrations.providerBrandId, event.a2pBrandId)
          : sql`true`,
        event.a2pCampaignId
          ? eq(messagingRegistrations.providerCampaignId, event.a2pCampaignId)
          : sql`true`,
      ),
    )
    .limit(2);
  if (registrationMatches.length !== 1 || !event.a2pObservedStatus) {
    return "retry";
  }
  const registration = registrationMatches[0]!;
  const [existingEvent] = await tx
    .select({ id: messagingRegistrationEvents.id })
    .from(messagingRegistrationEvents)
    .where(
      and(
        eq(messagingRegistrationEvents.practiceId, registration.practiceId),
        eq(messagingRegistrationEvents.operationId, event.id),
        eq(messagingRegistrationEvents.eventType, "provider_state_observed"),
      ),
    )
    .limit(1);
  if (existingEvent) return "projected";

  const next = mergeRegistrationStatus(
    registration.status,
    event.a2pObservedStatus,
  );
  const providerStatus =
    event.providerStatus ??
    event.a2pEventType ??
    event.a2pType ??
    event.a2pStatus;
  const [updated] = await tx
    .update(messagingRegistrations)
    .set({
      ...(event.providerEventType === "10dlc.brand.update"
        ? { providerBrandStatus: providerStatus }
        : { providerCampaignStatus: providerStatus }),
      status: next,
      statusDetail:
        next === "action_required" || next === "failed" || next === "suspended"
          ? "Carrier registration needs OpenVPM operator review."
          : "Carrier update received; OpenVPM will confirm full registration status.",
      lastError:
        next === "action_required" || next === "failed" || next === "suspended"
          ? event.providerDetail
          : null,
      lastSyncedAt: event.occurredAt ?? event.receivedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(messagingRegistrations.id, registration.id),
        eq(messagingRegistrations.status, registration.status),
        event.a2pBrandId
          ? eq(messagingRegistrations.providerBrandId, event.a2pBrandId)
          : sql`true`,
        event.a2pCampaignId
          ? eq(messagingRegistrations.providerCampaignId, event.a2pCampaignId)
          : sql`true`,
        event.a2pPhoneE164
          ? sql`exists (
              select 1
              from ${locationMessaging} as sender
              where sender.practice_id = ${registration.practiceId}
                and sender.provider = 'telnyx'
                and sender.sender_e164 = ${event.a2pPhoneE164}
                and sender.deleted_at is null
            )`
          : sql`true`,
        isNull(messagingRegistrations.deletedAt),
      ),
    )
    .returning();
  if (!updated) return "retry";

  await recordMessagingRegistrationEvent(tx, {
    registration: updated,
    eventType: "provider_state_observed",
    operation: "registration_reconciliation",
    statusBefore: registration.status,
    operationId: event.id,
    reasonCode: "carrier_webhook_observed",
    actor: systemMessagingRegistrationActor(),
  });
  await tx
    .update(locationMessaging)
    .set({
      registrationStatus: next,
      registrationDetail:
        next === "action_required" || next === "failed" || next === "suspended"
          ? "Carrier registration needs OpenVPM review."
          : "Carrier registration update received; confirmation is pending.",
      ...(next !== "active"
        ? {
            enabled: false,
            providerProfileReady: false,
            providerProfileSyncedAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(locationMessaging.practiceId, registration.practiceId),
        eq(locationMessaging.provider, "telnyx"),
        isNull(locationMessaging.deletedAt),
      ),
    );
  return "projected";
}

async function projectLockedEventInTransaction(
  tx: Database,
  event: StoredSmsProviderEvent,
  resolution: IntakeResolution,
  options: {
    allowDisabledInbound?: boolean;
    inboundRecipientLockAlreadyHeld?: boolean;
  } = {},
): Promise<{ outcome: SmsProviderEventProjectionOutcome }> {
  const attribution = event.practiceId
    ? {
        practiceId: event.practiceId,
        locationId: event.locationId,
      }
    : resolution.attribution;

  if (event.kind === "inbound") {
    if (!options.allowDisabledInbound && !hostedInboundProjectionEnabled()) {
      const outcome = await markRetryInTransaction(tx, event, {
        ...attribution,
        code: "inbound_projection_disabled",
        detail: "Inbound SMS projection is disabled for this deployment.",
        exhaustible: false,
      });
      return { outcome };
    }
    if (
      !attribution?.locationId ||
      !event.fromE164 ||
      !event.messageBody ||
      !event.inboundClassification
    ) {
      const outcome = await markRetryInTransaction(tx, event, {
        ...attribution,
        code: "inbound_attribution_pending",
        detail: "Inbound SMS is waiting for exact sender attribution.",
      });
      return { outcome };
    }
    const { projectInboundSmsReplyInTransaction } = await import("./inbound");
    await projectInboundSmsReplyInTransaction(tx, {
      provider: event.provider as InboundSmsProvider,
      practiceId: attribution.practiceId,
      locationId: attribution.locationId,
      fromPhone: event.fromE164,
      text: event.messageBody,
      providerMessageId: event.providerMessageId,
      classification: event.inboundClassification,
      occurredAt: event.occurredAt ?? event.receivedAt,
      recipientLockAlreadyHeld:
        options.inboundRecipientLockAlreadyHeld === true,
    });
    await markTerminalInTransaction(tx, event, {
      state: "projected",
      ...attribution,
    });
    return { outcome: "projected" };
  }

  if (event.kind === "delivery") {
    if (!event.providerMessageId || !event.deliveryClassification) {
      await markTerminalInTransaction(tx, event, {
        state: "quarantined",
        errorCode: "invalid_delivery_shape",
      });
      return { outcome: "quarantined" };
    }
    const result = await recordSmsDeliveryCallbackInTransaction(tx, {
      provider: event.provider as InboundSmsProvider,
      providerEventId: event.providerEventId,
      providerMessageId: event.providerMessageId,
      providerEventType: event.providerEventType,
      providerStatus: event.providerStatus,
      providerErrorCode: event.providerErrorCode,
      classification: event.deliveryClassification,
      occurredAt: event.occurredAt,
    });
    if (result.result === "ambiguous") {
      await markTerminalInTransaction(tx, event, {
        state: "quarantined",
        ...attribution,
        errorCode: "delivery_identity_conflict",
        errorDetail: "Delivery evidence has multiple exact send identities.",
      });
      return { outcome: "quarantined" };
    }
    if (result.result !== "projected") {
      const outcome = await markRetryInTransaction(tx, event, {
        ...attribution,
        code: `delivery_${result.result}`,
        detail: "Delivery evidence is durable but not yet fully projected.",
        exhaustible: false,
      });
      return { outcome };
    }
    if (!attribution) {
      const outcome = await markRetryInTransaction(tx, event, {
        code: "delivery_attribution_pending",
        detail: "Delivery evidence is waiting for exact tenant attribution.",
        exhaustible: false,
      });
      return { outcome };
    }
    await markTerminalInTransaction(tx, event, {
      state: "projected",
      ...attribution,
    });
    return { outcome: "projected" };
  }

  const a2pOutcome = await projectA2pEventInTransaction(tx, event, resolution);
  if (a2pOutcome === "retry") {
    const outcome = await markRetryInTransaction(tx, event, {
      ...attribution,
      code: "a2p_projection_pending",
      detail: "Carrier registration evidence could not yet be projected.",
    });
    return { outcome };
  }
  if (a2pOutcome === "quarantined") {
    await markTerminalInTransaction(tx, event, {
      state: "quarantined",
      ...attribution,
      errorCode: "a2p_identity_conflict",
      errorDetail: "Carrier registration identities conflict.",
    });
    return { outcome: "quarantined" };
  }
  if (!attribution) {
    const outcome = await markRetryInTransaction(tx, event, {
      code: "a2p_attribution_pending",
      detail: "Carrier registration event is waiting for exact attribution.",
    });
    return { outcome };
  }
  await markTerminalInTransaction(tx, event, {
    state: "projected",
    ...attribution,
  });
  return { outcome: "projected" };
}

async function projectSmsProviderEventWithLocksInTransaction(
  tx: Database,
  eventId: string,
  options: { lockedPracticeId?: string; force?: boolean } = {},
): Promise<{ outcome: SmsProviderEventProjectionOutcome }> {
  const [peek] = await tx
    .select()
    .from(smsProviderEvents)
    .where(eq(smsProviderEvents.id, eventId))
    .limit(1);
  if (!peek) return { outcome: "not_found" };
  if (terminalState(peek.state)) return { outcome: "already_terminal" };
  if (
    !options.force &&
    (peek.state === "blocked_recovery" || peek.nextAttemptAt! > new Date())
  ) {
    return {
      outcome: peek.state === "blocked_recovery" ? "blocked_recovery" : "retry",
    };
  }

  const initialResolution = await resolveStoredEventInTransaction(tx, peek);
  const practiceIds = [
    ...new Set([
      ...initialResolution.practiceIds,
      ...(peek.practiceId ? [peek.practiceId] : []),
    ]),
  ].sort();
  let practiceStates = new Map<string, boolean>();
  if (options.lockedPracticeId) {
    if (
      practiceIds.some((practiceId) => practiceId !== options.lockedPracticeId)
    ) {
      throw new Error(
        "Recovery drain event resolved outside its locked practice",
      );
    }
    practiceStates = new Map([[options.lockedPracticeId, false]]);
  } else {
    practiceStates = await lockPracticeStatesInTransaction(tx, practiceIds);
  }

  let inboundIdentityLocked = true;
  let inboundRecipientLockHeld = false;
  if (peek.kind === "inbound" && initialResolution.attribution) {
    inboundIdentityLocked = await lockMessagingLocationIdentityInTransaction(
      tx,
      {
        provider: peek.provider as InboundSmsProvider,
        practiceId: initialResolution.attribution.practiceId,
        locationId: initialResolution.attribution.locationId!,
        senderE164: peek.toE164,
        messagingProfileId: peek.messagingProfileId,
      },
    );
    if (inboundIdentityLocked && peek.fromE164) {
      await acquireSmsRecipientLockInTransaction(
        tx,
        initialResolution.attribution.practiceId,
        peek.fromE164,
      );
      inboundRecipientLockHeld = true;
    }
  }

  const [event] = await tx
    .select()
    .from(smsProviderEvents)
    .where(eq(smsProviderEvents.id, eventId))
    .limit(1)
    .for("update");
  if (!event) return { outcome: "not_found" };
  if (terminalState(event.state)) return { outcome: "already_terminal" };
  if (
    !options.force &&
    (event.state === "blocked_recovery" || event.nextAttemptAt! > new Date())
  ) {
    return {
      outcome:
        event.state === "blocked_recovery" ? "blocked_recovery" : "retry",
    };
  }

  const resolution = await resolveStoredEventInTransaction(tx, event);
  if (
    !resolution.practiceIds.every((practiceId) =>
      practiceIds.includes(practiceId),
    )
  ) {
    throw new Error("Provider event tenant changed during projection");
  }
  if (
    event.kind === "inbound" &&
    resolution.attribution &&
    (!inboundIdentityLocked ||
      !initialResolution.attribution ||
      initialResolution.attribution.practiceId !==
        resolution.attribution.practiceId ||
      initialResolution.attribution.locationId !==
        resolution.attribution.locationId)
  ) {
    await markTerminalInTransaction(tx, event, {
      state: "quarantined",
      errorCode: "sender_identity_drift",
      errorDetail:
        "Current messaging sender identity changed before projection.",
    });
    return { outcome: "quarantined" };
  }
  if (
    event.practiceId &&
    (!resolution.attribution ||
      resolution.attribution.practiceId !== event.practiceId ||
      (event.locationId !== null &&
        resolution.attribution.locationId !== event.locationId))
  ) {
    await markTerminalInTransaction(tx, event, {
      state: "quarantined",
      errorCode: "immutable_attribution_drift",
      errorDetail:
        "Current provider identity no longer matches immutable intake attribution.",
    });
    return { outcome: "quarantined" };
  }
  const attribution = event.practiceId
    ? { practiceId: event.practiceId, locationId: event.locationId }
    : resolution.attribution;
  const held = [...practiceStates.values()].some(Boolean);
  if (held) {
    if (!attribution) {
      const outcome = await markRetryInTransaction(tx, event, {
        code: "recovery_attribution_pending",
        detail:
          "Provider event overlaps a recovery hold without exact attribution.",
        exhaustible: false,
      });
      return { outcome };
    }
    await markBlockedRecoveryInTransaction(tx, event, attribution);
    return { outcome: "blocked_recovery" };
  }
  return projectLockedEventInTransaction(tx, event, resolution, {
    allowDisabledInbound: Boolean(options.lockedPracticeId && options.force),
    inboundRecipientLockAlreadyHeld: inboundRecipientLockHeld,
  });
}

export async function projectSmsProviderEvent(
  eventId: string,
): Promise<{ outcome: SmsProviderEventProjectionOutcome }> {
  try {
    return await withSystem(db, (tx) =>
      projectSmsProviderEventWithLocksInTransaction(tx, eventId),
    );
  } catch {
    return withSystem(db, async (tx) => {
      const [peek] = await tx
        .select()
        .from(smsProviderEvents)
        .where(eq(smsProviderEvents.id, eventId))
        .limit(1);
      if (!peek) return { outcome: "not_found" };
      if (terminalState(peek.state)) return { outcome: "already_terminal" };
      const resolution = await resolveStoredEventInTransaction(tx, peek);
      const practiceIds = [
        ...new Set([
          ...resolution.practiceIds,
          ...(peek.practiceId ? [peek.practiceId] : []),
        ]),
      ].sort();
      await lockPracticeStatesInTransaction(tx, practiceIds);
      const [event] = await tx
        .select()
        .from(smsProviderEvents)
        .where(eq(smsProviderEvents.id, eventId))
        .limit(1)
        .for("update");
      if (!event || terminalState(event.state)) {
        return { outcome: event ? "already_terminal" : "not_found" };
      }
      const outcome = await markRetryInTransaction(tx, event, {
        ...resolution.attribution,
        code: "projection_failed",
        detail: "Provider event projection failed and will be retried.",
      });
      return { outcome };
    });
  }
}

/** Transactional worker entry point used by recovery/concurrency orchestration. */
export async function projectSmsProviderEventInTransaction(
  tx: Database,
  eventId: string,
): Promise<{ outcome: SmsProviderEventProjectionOutcome }> {
  return projectSmsProviderEventWithLocksInTransaction(tx, eventId);
}

export async function projectSmsProviderEventForLockedPracticeInTransaction(
  tx: Database,
  opts: { practiceId: string; eventId: string; force: true },
): Promise<{ outcome: SmsProviderEventProjectionOutcome }> {
  return projectSmsProviderEventWithLocksInTransaction(tx, opts.eventId, {
    lockedPracticeId: opts.practiceId,
    force: true,
  });
}

export async function processSmsProviderEventBatch(
  opts: {
    limit?: number;
    budgetMs?: number;
    practiceId?: string;
  } = {},
): Promise<SmsProviderEventBatchResult> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const budgetMs = Math.min(30_000, Math.max(250, opts.budgetMs ?? 5_000));
  const startedAt = Date.now();
  const ids = await withSystem(db, (tx) =>
    tx
      .select({ id: smsProviderEvents.id })
      .from(smsProviderEvents)
      .where(
        and(
          inArray(smsProviderEvents.state, ["pending", "retry"]),
          lte(smsProviderEvents.nextAttemptAt, new Date()),
          opts.practiceId
            ? eq(smsProviderEvents.practiceId, opts.practiceId)
            : sql`true`,
        ),
      )
      .orderBy(
        asc(smsProviderEvents.nextAttemptAt),
        smsProviderEvents.receivedAt,
      )
      .limit(limit),
  );
  const result: SmsProviderEventBatchResult = {
    claimed: ids.length,
    projected: 0,
    ignored: 0,
    blockedRecovery: 0,
    retried: 0,
    quarantined: 0,
    remaining: 0,
    budgetExhausted: false,
  };
  for (const { id } of ids) {
    if (Date.now() - startedAt >= budgetMs) {
      result.budgetExhausted = true;
      break;
    }
    const projected = await projectSmsProviderEvent(id);
    if (projected.outcome === "projected") result.projected += 1;
    else if (projected.outcome === "ignored") result.ignored += 1;
    else if (projected.outcome === "blocked_recovery")
      result.blockedRecovery += 1;
    else if (projected.outcome === "quarantined") result.quarantined += 1;
    else if (projected.outcome === "retry") result.retried += 1;
  }
  const summary = await getSmsProviderEventBacklogSummary(undefined, {
    practiceId: opts.practiceId,
  });
  result.remaining =
    summary.pending +
    summary.retry +
    summary.blockedRecovery +
    summary.quarantined +
    summary.conflicts;
  return result;
}

type BacklogRow = {
  pending: number | string;
  retry: number | string;
  blockedRecovery: number | string;
  quarantined: number | string;
  conflicts: number | string;
  oldestUnresolvedAt: Date | string | null;
};

export async function getSmsProviderEventBacklogSummary(
  tx?: Database,
  opts: { practiceId?: string; since?: Date } = {},
): Promise<SmsProviderEventBacklogSummary> {
  const load = async (database: Database) => {
    const result = await database.execute(sql`
      with unresolved_conflicts as (
        select conflict.received_at
        from sms_provider_event_conflicts conflict
        join sms_provider_events event
          on event.id = conflict.original_event_id
        where (
            not exists (
              select 1
              from sms_provider_event_conflict_reviews review
              where review.conflict_id = conflict.id
            )
            or not exists (
              select 1
              from sms_provider_event_resolutions resolution
              where resolution.conflict_id = conflict.id
            )
          )
          and (${opts.practiceId ?? null}::uuid is null or event.practice_id = ${opts.practiceId ?? null}::uuid)
          and (${opts.since ?? null}::timestamptz is null or conflict.received_at >= ${opts.since ?? null}::timestamptz)
      )
      select
        count(*) filter (where state = 'pending')::int as pending,
        count(*) filter (where state = 'retry')::int as retry,
        count(*) filter (where state = 'blocked_recovery')::int as "blockedRecovery",
        count(*) filter (where state = 'quarantined')::int as quarantined,
        (select count(*)::int from unresolved_conflicts) as conflicts,
        least(
          min(received_at),
          (select min(received_at) from unresolved_conflicts)
        ) as "oldestUnresolvedAt"
      from sms_provider_events event
      where event.state in ('pending', 'retry', 'blocked_recovery', 'quarantined')
        and (
          event.state <> 'quarantined'
          or not ${smsProviderEventQuarantineIsRemediatedSql}
        )
        and (${opts.practiceId ?? null}::uuid is null or event.practice_id = ${opts.practiceId ?? null}::uuid)
        and (${opts.since ?? null}::timestamptz is null or event.received_at >= ${opts.since ?? null}::timestamptz)
    `);
    const row = rowsFromExecute<BacklogRow>(result)[0];
    const oldest = row?.oldestUnresolvedAt;
    return {
      pending: Number(row?.pending ?? 0),
      retry: Number(row?.retry ?? 0),
      blockedRecovery: Number(row?.blockedRecovery ?? 0),
      quarantined: Number(row?.quarantined ?? 0),
      conflicts: Number(row?.conflicts ?? 0),
      oldestUnresolvedAt:
        oldest instanceof Date ? oldest : oldest ? new Date(oldest) : null,
    };
  };
  return tx ? load(tx) : withSystem(db, load);
}
