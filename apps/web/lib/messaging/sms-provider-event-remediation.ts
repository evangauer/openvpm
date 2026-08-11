import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  communications,
  locationMessaging,
  messagingRegistrationEvents,
  messagingRegistrations,
  smsConsentEvents,
  smsDeliveryEventHistory,
  smsDeliveryEvents,
  smsProviderEventConflictReviews,
  smsProviderEventConflicts,
  smsProviderEventResolutions,
  smsProviderEvents,
  smsSuppressions,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { inboundSmsConsentEventKey } from "./consent-events";
import {
  inboundSmsDedupeKey,
  projectInboundSmsReplyInTransaction,
} from "./inbound";
import {
  lockSmsProviderEventForRemediationInTransaction,
  type LockedSmsProviderEventRemediation,
} from "./sms-provider-events";
import { recordSmsDeliveryCallbackInTransaction } from "./sms-delivery-ledger";
import { revokeSmsConsentAfterRecipientLockInTransaction } from "./suppression";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_EVIDENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/#-]{2,254}$/;
const PHONE_LIKE_OPERATIONAL_ID = /^\+?\d[\d ().-]{6,18}$/;
const CARRIER_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1_000;

export type SmsProviderEventResolutionMode =
  | "authoritative_projection"
  | "conservative_opt_out"
  | "carrier_state_reconciled"
  | "provider_attested_no_projection";

export type SmsProviderEventResolutionIncident = {
  kind: "inbound" | "delivery" | "a2p";
  state:
    | "pending"
    | "retry"
    | "blocked_recovery"
    | "quarantined"
    | "projected"
    | "ignored";
  lastErrorCode: string | null;
  practiceId: string | null;
  locationId: string | null;
  conflictId?: string | null;
};

export function isValidProviderExternalEvidenceReference(
  value: string,
): boolean {
  return (
    EXTERNAL_EVIDENCE.test(value) && !PHONE_LIKE_OPERATIONAL_ID.test(value)
  );
}

export function smsProviderEventResolutionModesForIncident(
  incident: SmsProviderEventResolutionIncident,
): SmsProviderEventResolutionMode[] {
  const isConflict = Boolean(incident.conflictId);
  if (!isConflict && incident.state !== "quarantined") return [];
  if (incident.kind === "inbound") {
    if (isConflict) {
      return incident.practiceId && incident.locationId
        ? ["conservative_opt_out"]
        : [];
    }
    return [
      ...(incident.practiceId && incident.locationId
        ? (["authoritative_projection"] as const)
        : []),
      ...(incident.practiceId &&
      incident.locationId &&
      (incident.lastErrorCode === "sender_identity_drift" ||
        incident.lastErrorCode === "immutable_attribution_drift")
        ? (["conservative_opt_out"] as const)
        : []),
    ];
  }
  if (incident.kind === "a2p") {
    return incident.practiceId ? ["carrier_state_reconciled"] : [];
  }
  return [
    ...(incident.practiceId ? (["authoritative_projection"] as const) : []),
    "provider_attested_no_projection",
  ];
}

type ResolutionActor = {
  actorIdentity: string;
  actorName: string;
};

type ResolutionBase = ResolutionActor & {
  eventId: string;
  conflictId?: string | null;
  operationId: string;
};

export type ResolveSmsProviderEventInput =
  | (ResolutionBase & { resolution: "authoritative_projection" })
  | (ResolutionBase & { resolution: "conservative_opt_out" })
  | (ResolutionBase & {
      resolution: "carrier_state_reconciled";
      messagingRegistrationEventId: string;
    })
  | (ResolutionBase & {
      resolution: "provider_attested_no_projection";
      externalEvidenceReference: string;
      reasonCode:
        | "provider_support_invalid_callback"
        | "provider_support_duplicate_callback";
      providerAttestationConfirmed: true;
    });

type ResolutionEvidence = {
  inboundCommunicationId: string | null;
  smsConsentEventId: string | null;
  smsDeliveryEventId: string | null;
  messagingRegistrationEventId: string | null;
  externalEvidenceReference: string | null;
};

export type SmsProviderEventResolutionResult = {
  resolutionId: string;
  eventId: string;
  conflictId: string | null;
  practiceId: string | null;
  resolution: SmsProviderEventResolutionMode;
  duplicate: boolean;
};

export type SmsProviderEventResolutionHistoryItem = {
  resolutionId: string;
  resolvedAt: Date;
  eventId: string;
  conflictId: string | null;
  practiceId: string | null;
  provider: string;
  kind: "inbound" | "delivery" | "a2p";
  resolution: SmsProviderEventResolutionMode;
  reasonCode: string;
  operatorLabel: string;
  evidenceType:
    | "communication"
    | "consent"
    | "delivery"
    | "carrier_registration"
    | "external_attestation";
  externalEvidenceReference: string | null;
};

function bounded(value: string | null | undefined, max: number): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > max) return null;
  return normalized;
}

function normalizeInput(input: ResolveSmsProviderEventInput) {
  const actorIdentity = bounded(input.actorIdentity, 255);
  const actorName = bounded(input.actorName, 255);
  const conflictId = input.conflictId ?? null;
  if (
    !UUID.test(input.eventId) ||
    !UUID.test(input.operationId) ||
    (conflictId !== null && !UUID.test(conflictId)) ||
    !actorIdentity ||
    !actorName
  ) {
    throw new Error(
      "Complete bounded provider-event resolution evidence is required.",
    );
  }
  if (
    input.resolution === "carrier_state_reconciled" &&
    !UUID.test(input.messagingRegistrationEventId)
  ) {
    throw new Error("A valid carrier reconciliation evidence id is required.");
  }
  if (
    input.resolution === "provider_attested_no_projection" &&
    (!input.providerAttestationConfirmed ||
      !isValidProviderExternalEvidenceReference(
        input.externalEvidenceReference,
      ))
  ) {
    throw new Error(
      "Explicit bounded provider-support attestation evidence is required.",
    );
  }
  return { ...input, conflictId, actorIdentity, actorName };
}

function reasonFor(
  input: ReturnType<typeof normalizeInput>,
  locked: LockedSmsProviderEventRemediation,
): {
  reasonCode: string;
  detail: string;
} {
  switch (input.resolution) {
    case "authoritative_projection":
      return {
        reasonCode:
          locked.event.kind === "delivery"
            ? "delivery_reconciled"
            : "projection_repaired",
        detail: "Exact provider evidence was projected and verified.",
      };
    case "conservative_opt_out":
      return {
        reasonCode: input.conflictId
          ? "provider_identity_conflict_opt_out"
          : "sender_identity_drift_opt_out",
        detail:
          "Conflicting inbound evidence was resolved conservatively as an opt-out.",
      };
    case "carrier_state_reconciled":
      return {
        reasonCode: "carrier_state_readback_confirmed",
        detail:
          "Current carrier registration state was reconciled before resolution.",
      };
    case "provider_attested_no_projection":
      return {
        reasonCode: input.reasonCode,
        detail:
          "Provider support attested that no tenant projection is required.",
      };
  }
}

function requestReasonMatches(
  row: typeof smsProviderEventResolutions.$inferSelect,
  input: ReturnType<typeof normalizeInput>,
): boolean {
  if (input.resolution === "authoritative_projection") {
    return (
      row.reasonCode === "projection_repaired" ||
      row.reasonCode === "delivery_reconciled"
    );
  }
  if (input.resolution === "conservative_opt_out") {
    return (
      row.reasonCode ===
      (input.conflictId
        ? "provider_identity_conflict_opt_out"
        : "sender_identity_drift_opt_out")
    );
  }
  if (input.resolution === "carrier_state_reconciled") {
    return row.reasonCode === "carrier_state_readback_confirmed";
  }
  return row.reasonCode === input.reasonCode;
}

function sameRequest(
  row: typeof smsProviderEventResolutions.$inferSelect,
  input: ReturnType<typeof normalizeInput>,
): boolean {
  return (
    row.eventId === input.eventId &&
    row.conflictId === input.conflictId &&
    row.operationId === input.operationId &&
    row.resolution === input.resolution &&
    row.resolvedByIdentity === input.actorIdentity &&
    row.resolvedByName === input.actorName &&
    requestReasonMatches(row, input) &&
    row.messagingRegistrationEventId ===
      (input.resolution === "carrier_state_reconciled"
        ? input.messagingRegistrationEventId
        : null) &&
    row.externalEvidenceReference ===
      (input.resolution === "provider_attested_no_projection"
        ? input.externalEvidenceReference
        : null)
  );
}

function resultFromRow(
  row: typeof smsProviderEventResolutions.$inferSelect,
  duplicate: boolean,
): SmsProviderEventResolutionResult {
  return {
    resolutionId: row.id,
    eventId: row.eventId,
    conflictId: row.conflictId,
    practiceId: row.practiceId,
    resolution: row.resolution,
    duplicate,
  };
}

async function inboundAuthoritativeEvidence(
  tx: Database,
  locked: LockedSmsProviderEventRemediation,
): Promise<ResolutionEvidence> {
  const { event, attribution } = locked;
  if (
    event.kind !== "inbound" ||
    !attribution?.locationId ||
    !event.fromE164 ||
    !event.messageBody ||
    !event.providerMessageId ||
    !event.inboundClassification ||
    !locked.inboundRecipientLockHeld
  ) {
    throw new Error("Inbound provider evidence is not exactly projectable.");
  }
  await projectInboundSmsReplyInTransaction(tx, {
    provider: event.provider as "telnyx" | "twilio",
    practiceId: attribution.practiceId,
    locationId: attribution.locationId,
    fromPhone: event.fromE164,
    text: event.messageBody,
    providerMessageId: event.providerMessageId,
    classification: event.inboundClassification,
    occurredAt: event.occurredAt ?? event.receivedAt,
    recipientLockAlreadyHeld: true,
  });
  const dedupeKey = inboundSmsDedupeKey(
    event.provider as "telnyx" | "twilio",
    event.providerMessageId,
  );
  const [communication] = await tx
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.practiceId, attribution.practiceId),
        eq(communications.channel, "sms"),
        eq(communications.direction, "inbound"),
        eq(communications.providerMessageId, event.providerMessageId),
        eq(communications.dedupeKey, dedupeKey!),
        eq(communications.content, event.messageBody),
        isNull(communications.deletedAt),
      ),
    )
    .limit(1);
  if (!communication) {
    throw new Error("Authoritative inbound communication evidence is missing.");
  }
  let consentId: string | null = null;
  if (
    event.inboundClassification === "stop" ||
    event.inboundClassification === "start"
  ) {
    const action =
      event.inboundClassification === "stop" ? "revoked" : "granted";
    const [consent] = await tx
      .select({ id: smsConsentEvents.id })
      .from(smsConsentEvents)
      .where(
        and(
          eq(smsConsentEvents.practiceId, attribution.practiceId),
          eq(smsConsentEvents.locationId, attribution.locationId),
          eq(smsConsentEvents.destinationE164, event.fromE164),
          eq(smsConsentEvents.action, action),
          eq(smsConsentEvents.provider, event.provider),
          eq(smsConsentEvents.providerMessageId, event.providerMessageId),
          eq(
            smsConsentEvents.eventKey,
            inboundSmsConsentEventKey(
              event.provider as "telnyx" | "twilio",
              event.providerMessageId,
              action,
            ),
          ),
        ),
      )
      .limit(1);
    if (!consent) {
      throw new Error("Authoritative inbound consent evidence is missing.");
    }
    consentId = consent.id;
  }
  return {
    inboundCommunicationId: communication.id,
    smsConsentEventId: consentId,
    smsDeliveryEventId: null,
    messagingRegistrationEventId: null,
    externalEvidenceReference: null,
  };
}

async function conservativeOptOutEvidence(
  tx: Database,
  locked: LockedSmsProviderEventRemediation,
  input: ReturnType<typeof normalizeInput>,
): Promise<ResolutionEvidence> {
  const { event, attribution } = locked;
  if (
    event.kind !== "inbound" ||
    !attribution?.locationId ||
    !event.fromE164 ||
    !locked.inboundRecipientLockHeld
  ) {
    throw new Error("Conservative opt-out requires exact inbound attribution.");
  }
  const evidenceKey = `provider_event_resolution:${input.operationId}:${input.conflictId ?? input.eventId}:revoked`;
  await revokeSmsConsentAfterRecipientLockInTransaction(tx, {
    practiceId: attribution.practiceId,
    locationId: attribution.locationId,
    phone: event.fromE164,
    reason: "stop",
    detail: "Provider event conflict resolved conservatively as an opt-out.",
    evidence: {
      source: "provider_event_resolution:v1",
      detail: "Provider event conflict resolved conservatively as an opt-out.",
      actorType: "system",
      eventKey: evidenceKey,
      occurredAt: new Date(),
    },
  });
  const [consent] = await tx
    .select({ id: smsConsentEvents.id })
    .from(smsConsentEvents)
    .where(
      and(
        eq(smsConsentEvents.practiceId, attribution.practiceId),
        eq(smsConsentEvents.locationId, attribution.locationId),
        eq(smsConsentEvents.destinationE164, event.fromE164),
        eq(smsConsentEvents.action, "revoked"),
        eq(smsConsentEvents.actorType, "system"),
        eq(smsConsentEvents.source, "provider_event_resolution:v1"),
        eq(smsConsentEvents.eventKey, evidenceKey),
        isNull(smsConsentEvents.provider),
        isNull(smsConsentEvents.providerMessageId),
      ),
    )
    .limit(1);
  const [suppression] = await tx
    .select({ id: smsSuppressions.id })
    .from(smsSuppressions)
    .where(
      and(
        eq(smsSuppressions.practiceId, attribution.practiceId),
        eq(smsSuppressions.phone, event.fromE164),
        isNull(smsSuppressions.deletedAt),
      ),
    )
    .limit(1);
  if (!consent || !suppression) {
    throw new Error("Conservative opt-out evidence is incomplete.");
  }
  return {
    inboundCommunicationId: null,
    smsConsentEventId: consent.id,
    smsDeliveryEventId: null,
    messagingRegistrationEventId: null,
    externalEvidenceReference: null,
  };
}

async function deliveryAuthoritativeEvidence(
  tx: Database,
  locked: LockedSmsProviderEventRemediation,
): Promise<ResolutionEvidence> {
  const { event, attribution } = locked;
  if (
    event.kind !== "delivery" ||
    !attribution ||
    !event.providerMessageId ||
    !event.deliveryClassification
  ) {
    throw new Error("Delivery evidence is not exactly projectable.");
  }
  const result = await recordSmsDeliveryCallbackInTransaction(tx, {
    provider: event.provider as "telnyx" | "twilio",
    providerEventId: event.providerEventId,
    providerMessageId: event.providerMessageId,
    providerEventType: event.providerEventType,
    providerStatus: event.providerStatus,
    providerErrorCode: event.providerErrorCode,
    classification: event.deliveryClassification,
    occurredAt: event.occurredAt,
  });
  if (result.result !== "projected") {
    throw new Error(
      "Delivery evidence must be exactly attributed and projected before resolution.",
    );
  }
  const [delivery] = await tx
    .select({ id: smsDeliveryEvents.id })
    .from(smsDeliveryEvents)
    .where(
      and(
        eq(smsDeliveryEvents.id, result.eventId),
        eq(smsDeliveryEvents.provider, event.provider),
        eq(smsDeliveryEvents.providerMessageId, event.providerMessageId),
        eq(smsDeliveryEvents.providerEventType, event.providerEventType),
        eq(smsDeliveryEvents.classification, event.deliveryClassification),
      ),
    )
    .limit(1);
  if (!delivery) throw new Error("Immutable delivery evidence is missing.");
  const [history] = await tx
    .select({ id: smsDeliveryEventHistory.id })
    .from(smsDeliveryEventHistory)
    .where(
      and(
        eq(smsDeliveryEventHistory.deliveryEventId, delivery.id),
        eq(smsDeliveryEventHistory.practiceId, attribution.practiceId),
        inArray(smsDeliveryEventHistory.result, ["projected", "reconciled"]),
      ),
    )
    .orderBy(
      desc(smsDeliveryEventHistory.createdAt),
      desc(smsDeliveryEventHistory.id),
    )
    .limit(1);
  if (!history) {
    throw new Error("Delivery projection evidence is missing.");
  }
  return {
    inboundCommunicationId: null,
    smsConsentEventId: null,
    smsDeliveryEventId: delivery.id,
    messagingRegistrationEventId: null,
    externalEvidenceReference: null,
  };
}

async function carrierReconciliationEvidence(
  tx: Database,
  locked: LockedSmsProviderEventRemediation,
  input: ReturnType<typeof normalizeInput>,
): Promise<ResolutionEvidence> {
  const { event, attribution } = locked;
  if (
    input.resolution !== "carrier_state_reconciled" ||
    event.kind !== "a2p" ||
    !attribution
  ) {
    throw new Error(
      "Carrier reconciliation resolution requires exact A2P attribution.",
    );
  }
  const cutoff = new Date(Date.now() - CARRIER_EVIDENCE_MAX_AGE_MS);
  const [evidence] = await tx
    .select({
      id: messagingRegistrationEvents.id,
      locationId: messagingRegistrationEvents.locationId,
    })
    .from(messagingRegistrationEvents)
    .innerJoin(
      messagingRegistrations,
      and(
        eq(
          messagingRegistrations.id,
          messagingRegistrationEvents.registrationId,
        ),
        eq(
          messagingRegistrations.practiceId,
          messagingRegistrationEvents.practiceId,
        ),
        eq(
          messagingRegistrations.status,
          messagingRegistrationEvents.statusAfter,
        ),
        isNull(messagingRegistrations.deletedAt),
      ),
    )
    .where(
      and(
        eq(messagingRegistrationEvents.id, input.messagingRegistrationEventId),
        eq(messagingRegistrationEvents.practiceId, attribution.practiceId),
        eq(messagingRegistrationEvents.provider, event.provider),
        eq(messagingRegistrationEvents.eventType, "provider_state_observed"),
        eq(
          messagingRegistrationEvents.operation,
          "registration_reconciliation",
        ),
        eq(messagingRegistrationEvents.operationId, input.operationId),
        eq(
          messagingRegistrationEvents.reasonCode,
          "carrier_registration_reconciled",
        ),
        sql`${messagingRegistrationEvents.createdAt} >= ${cutoff}`,
        event.a2pBrandId
          ? eq(messagingRegistrationEvents.providerBrandId, event.a2pBrandId)
          : sql`true`,
        event.a2pCampaignId
          ? eq(
              messagingRegistrationEvents.providerCampaignId,
              event.a2pCampaignId,
            )
          : sql`true`,
        event.a2pPhoneE164
          ? eq(messagingRegistrationEvents.locationId, event.locationId!)
          : sql`true`,
      ),
    )
    .limit(1);
  if (!evidence) {
    throw new Error("Current carrier reconciliation evidence is missing.");
  }
  await tx
    .update(locationMessaging)
    .set({
      enabled: false,
      providerProfileReady: false,
      providerProfileSyncedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(locationMessaging.practiceId, attribution.practiceId),
        eq(locationMessaging.provider, "telnyx"),
        isNull(locationMessaging.deletedAt),
      ),
    );
  if (event.a2pPhoneE164) {
    const [sender] = await tx
      .select({ id: locationMessaging.id })
      .from(locationMessaging)
      .where(
        and(
          eq(locationMessaging.practiceId, attribution.practiceId),
          eq(locationMessaging.locationId, event.locationId!),
          eq(locationMessaging.provider, "telnyx"),
          eq(locationMessaging.senderE164, event.a2pPhoneE164),
          eq(locationMessaging.enabled, false),
          eq(locationMessaging.providerProfileReady, false),
          isNull(locationMessaging.deletedAt),
        ),
      )
      .limit(1);
    if (!sender || evidence.locationId !== event.locationId) {
      throw new Error(
        "Phone-level carrier reconciliation is not bound to a disabled exact sender.",
      );
    }
  }
  return {
    inboundCommunicationId: null,
    smsConsentEventId: null,
    smsDeliveryEventId: null,
    messagingRegistrationEventId: evidence.id,
    externalEvidenceReference: null,
  };
}

function assertModeAllowed(
  locked: LockedSmsProviderEventRemediation,
  input: ReturnType<typeof normalizeInput>,
): void {
  const { event } = locked;
  const allowed = smsProviderEventResolutionModesForIncident({
    kind: event.kind,
    state: event.state,
    lastErrorCode: event.lastErrorCode,
    practiceId: event.practiceId,
    locationId: event.locationId,
    conflictId: input.conflictId,
  });
  if (!allowed.includes(input.resolution)) {
    throw new Error(
      "This event requires its kind-specific safe resolution mode.",
    );
  }
}

async function appendConflictReview(
  tx: Database,
  conflictId: string,
  input: ReturnType<typeof normalizeInput>,
): Promise<void> {
  const [existing] = await tx
    .select({ id: smsProviderEventConflictReviews.id })
    .from(smsProviderEventConflictReviews)
    .where(eq(smsProviderEventConflictReviews.conflictId, conflictId))
    .limit(1);
  if (existing) return;
  const conflictReview =
    input.resolution === "authoritative_projection"
      ? {
          resolution: "semantic_duplicate_confirmed" as const,
          reasonCode: "signature_evidence_verified" as const,
        }
      : input.resolution === "carrier_state_reconciled"
        ? {
            resolution: "provider_identity_rotated" as const,
            reasonCode: "provider_identity_reprovisioned" as const,
          }
        : {
            resolution: "incident_closed_no_projection" as const,
            reasonCode:
              input.resolution === "provider_attested_no_projection"
                ? ("provider_support_incident_closed" as const)
                : ("security_review_closed" as const),
          };
  await tx
    .insert(smsProviderEventConflictReviews)
    .values({
      conflictId,
      operationId: input.operationId,
      ...conflictReview,
      detail: "Conflict closed by audited provider-event remediation.",
      reviewedByIdentity: input.actorIdentity,
      reviewedByName: input.actorName,
    })
    .onConflictDoNothing();
  const [review] = await tx
    .select({ id: smsProviderEventConflictReviews.id })
    .from(smsProviderEventConflictReviews)
    .where(eq(smsProviderEventConflictReviews.conflictId, conflictId))
    .limit(1);
  if (!review)
    throw new Error("Provider-event conflict review was not durable.");
}

async function resolutionEvidence(
  tx: Database,
  locked: LockedSmsProviderEventRemediation,
  input: ReturnType<typeof normalizeInput>,
): Promise<ResolutionEvidence> {
  switch (input.resolution) {
    case "authoritative_projection":
      return locked.event.kind === "inbound"
        ? inboundAuthoritativeEvidence(tx, locked)
        : deliveryAuthoritativeEvidence(tx, locked);
    case "conservative_opt_out":
      return conservativeOptOutEvidence(tx, locked, input);
    case "carrier_state_reconciled":
      return carrierReconciliationEvidence(tx, locked, input);
    case "provider_attested_no_projection":
      return {
        inboundCommunicationId: null,
        smsConsentEventId: null,
        smsDeliveryEventId: null,
        messagingRegistrationEventId: null,
        externalEvidenceReference: input.externalEvidenceReference,
      };
  }
}

export async function resolveSmsProviderEventInTransaction(
  tx: Database,
  rawInput: ResolveSmsProviderEventInput,
  options: { lockedPracticeId?: string } = {},
): Promise<SmsProviderEventResolutionResult> {
  const input = normalizeInput(rawInput);
  const [priorOperation] = await tx
    .select()
    .from(smsProviderEventResolutions)
    .where(eq(smsProviderEventResolutions.operationId, input.operationId))
    .limit(1);
  if (priorOperation) {
    if (!sameRequest(priorOperation, input)) {
      throw new Error("Provider-event resolution operation id collision.");
    }
    return resultFromRow(priorOperation, true);
  }

  const locked = await lockSmsProviderEventForRemediationInTransaction(
    tx,
    input.eventId,
    {
      lockedPracticeId: options.lockedPracticeId,
      allowGloballyUnattributedDelivery:
        input.resolution === "provider_attested_no_projection",
      allowImmutableInboundOptOut: input.resolution === "conservative_opt_out",
      // This is the only service path allowed to repair a terminal provider
      // incident while recovery is held. The lock helper takes the practice
      // row FOR UPDATE so release and remediation cannot pass one another.
      allowRecoveryHeld: true,
    },
  );
  if (input.conflictId) {
    const [conflict] = await tx
      .select({ id: smsProviderEventConflicts.id })
      .from(smsProviderEventConflicts)
      .where(
        and(
          eq(smsProviderEventConflicts.id, input.conflictId),
          eq(smsProviderEventConflicts.originalEventId, input.eventId),
        ),
      )
      .limit(1)
      .for("update");
    if (!conflict) {
      throw new Error("Provider-event conflict does not belong to this event.");
    }
  }
  assertModeAllowed(locked, input);

  const [priorTarget] = await tx
    .select()
    .from(smsProviderEventResolutions)
    .where(
      input.conflictId
        ? eq(smsProviderEventResolutions.conflictId, input.conflictId)
        : and(
            eq(smsProviderEventResolutions.eventId, input.eventId),
            isNull(smsProviderEventResolutions.conflictId),
          ),
    )
    .limit(1);
  if (priorTarget) {
    if (!sameRequest(priorTarget, input)) {
      throw new Error("Provider event incident is already resolved.");
    }
    return resultFromRow(priorTarget, true);
  }

  const evidence = await resolutionEvidence(tx, locked, input);
  if (input.conflictId) {
    await appendConflictReview(tx, input.conflictId, input);
  }
  const reason = reasonFor(input, locked);
  const [inserted] = await tx
    .insert(smsProviderEventResolutions)
    .values({
      eventId: input.eventId,
      conflictId: input.conflictId,
      operationId: input.operationId,
      practiceId: locked.attribution?.practiceId ?? null,
      resolution: input.resolution,
      ...evidence,
      ...reason,
      resolvedByIdentity: input.actorIdentity,
      resolvedByName: input.actorName,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return resultFromRow(inserted, false);

  const [winner] = await tx
    .select()
    .from(smsProviderEventResolutions)
    .where(eq(smsProviderEventResolutions.operationId, input.operationId))
    .limit(1);
  if (!winner || !sameRequest(winner, input)) {
    throw new Error(
      "Provider-event resolution collision; nothing was changed.",
    );
  }
  return resultFromRow(winner, true);
}

export async function resolveSmsProviderEvent(
  input: ResolveSmsProviderEventInput,
): Promise<SmsProviderEventResolutionResult> {
  return withSystem(db, (tx) =>
    resolveSmsProviderEventInTransaction(tx, input),
  );
}

export async function loadSmsProviderEventResolutionHistory(
  database: Database,
  options: { practiceId?: string; limit?: number } = {},
): Promise<{
  cacheControl: "no-store";
  events: SmsProviderEventResolutionHistoryItem[];
  truncated: boolean;
}> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  return withSystem(database, async (tx) => {
    const rows = await tx
      .select({
        resolutionId: smsProviderEventResolutions.id,
        resolvedAt: smsProviderEventResolutions.resolvedAt,
        eventId: smsProviderEventResolutions.eventId,
        conflictId: smsProviderEventResolutions.conflictId,
        practiceId: smsProviderEventResolutions.practiceId,
        provider: smsProviderEvents.provider,
        kind: smsProviderEvents.kind,
        resolution: smsProviderEventResolutions.resolution,
        reasonCode: smsProviderEventResolutions.reasonCode,
        resolvedByIdentity: smsProviderEventResolutions.resolvedByIdentity,
        resolvedByName: smsProviderEventResolutions.resolvedByName,
        inboundCommunicationId:
          smsProviderEventResolutions.inboundCommunicationId,
        smsConsentEventId: smsProviderEventResolutions.smsConsentEventId,
        smsDeliveryEventId: smsProviderEventResolutions.smsDeliveryEventId,
        messagingRegistrationEventId:
          smsProviderEventResolutions.messagingRegistrationEventId,
        externalEvidenceReference:
          smsProviderEventResolutions.externalEvidenceReference,
      })
      .from(smsProviderEventResolutions)
      .innerJoin(
        smsProviderEvents,
        eq(smsProviderEvents.id, smsProviderEventResolutions.eventId),
      )
      .where(
        options.practiceId
          ? eq(smsProviderEventResolutions.practiceId, options.practiceId)
          : sql`true`,
      )
      .orderBy(
        desc(smsProviderEventResolutions.resolvedAt),
        desc(smsProviderEventResolutions.id),
      )
      .limit(limit + 1);
    return {
      cacheControl: "no-store" as const,
      events: rows.slice(0, limit).map((row) => ({
        resolutionId: row.resolutionId,
        resolvedAt: row.resolvedAt,
        eventId: row.eventId,
        conflictId: row.conflictId,
        practiceId: row.practiceId,
        provider: row.provider,
        kind: row.kind,
        resolution: row.resolution,
        reasonCode: row.reasonCode,
        operatorLabel:
          row.resolvedByIdentity || row.resolvedByName || "OpenVPM operator",
        evidenceType: row.externalEvidenceReference
          ? "external_attestation"
          : row.messagingRegistrationEventId
            ? "carrier_registration"
            : row.smsDeliveryEventId
              ? "delivery"
              : row.inboundCommunicationId
                ? "communication"
                : "consent",
        externalEvidenceReference:
          row.externalEvidenceReference &&
          !PHONE_LIKE_OPERATIONAL_ID.test(row.externalEvidenceReference)
            ? row.externalEvidenceReference
            : null,
      })),
      truncated: rows.length > limit,
    };
  });
}
