import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { communications } from "./communications";
import { messagingRegistrationStatusEnum } from "./messaging";
import { messagingRegistrationEvents } from "./messaging-registration-events";
import { locations, practices } from "./practices";
import { smsConsentEvents } from "./sms-consent-events";
import {
  smsDeliveryClassificationEnum,
  smsDeliveryEvents,
} from "./sms-send-attempts";

export const smsProviderEventKindEnum = pgEnum("sms_provider_event_kind", [
  "inbound",
  "delivery",
  "a2p",
]);

export const smsProviderEventStateEnum = pgEnum("sms_provider_event_state", [
  "pending",
  "retry",
  "blocked_recovery",
  "projected",
  "ignored",
  "quarantined",
]);

export const smsProviderInboundClassificationEnum = pgEnum(
  "sms_provider_inbound_classification",
  ["stop", "start", "help", "other"],
);

export const smsProviderEventConflictResolutionEnum = pgEnum(
  "sms_provider_event_conflict_resolution",
  [
    "semantic_duplicate_confirmed",
    "provider_identity_rotated",
    "incident_closed_no_projection",
  ],
);

export const smsProviderEventResolutionEnum = pgEnum(
  "sms_provider_event_resolution",
  [
    "authoritative_projection",
    "conservative_opt_out",
    "carrier_state_reconciled",
    "provider_attested_no_projection",
  ],
);

/**
 * System-only SMS provider evidence must never be included in clinic backup
 * artifacts. Keeping the denylist beside the schema gives backup consumers a
 * stable, exported contract instead of relying on an undocumented omission.
 */
export const smsProviderEventSystemOnlyBackupExcludedTables = [
  "sms_provider_events",
  "sms_provider_event_conflicts",
  "sms_provider_event_conflict_reviews",
  "sms_provider_event_resolutions",
] as const;

/**
 * Durable, provider-neutral inbox for signed SMS provider facts. The webhook
 * request is normalized before insertion; raw provider payloads are never
 * retained. Projection is performed in a short database transaction.
 */
export const smsProviderEvents = pgTable(
  "sms_provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    provider: varchar("provider", { length: 16 }).notNull(),
    kind: smsProviderEventKindEnum("kind").notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    providerEventType: varchar("provider_event_type", { length: 80 }).notNull(),
    eventKey: varchar("event_key", { length: 255 }).notNull(),
    rawBodyFingerprintSha256: varchar("raw_body_fingerprint_sha256", {
      length: 64,
    }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    fromE164: varchar("from_e164", { length: 16 }),
    toE164: varchar("to_e164", { length: 16 }),
    messagingProfileId: varchar("messaging_profile_id", { length: 128 }),
    messageBody: text("message_body"),
    inboundClassification: smsProviderInboundClassificationEnum(
      "inbound_classification",
    ),
    deliveryClassification: smsDeliveryClassificationEnum(
      "delivery_classification",
    ),
    providerStatus: varchar("provider_status", { length: 80 }),
    providerErrorCode: varchar("provider_error_code", { length: 80 }),
    a2pBrandId: varchar("a2p_brand_id", { length: 128 }),
    a2pCampaignId: varchar("a2p_campaign_id", { length: 128 }),
    a2pPhoneE164: varchar("a2p_phone_e164", { length: 16 }),
    a2pStatus: varchar("a2p_status", { length: 80 }),
    a2pType: varchar("a2p_type", { length: 80 }),
    a2pEventType: varchar("a2p_event_type", { length: 80 }),
    a2pObservedStatus: messagingRegistrationStatusEnum("a2p_observed_status"),
    providerDetail: varchar("provider_detail", { length: 1000 }),
    practiceId: uuid("practice_id").references(() => practices.id),
    locationId: uuid("location_id"),
    state: smsProviderEventStateEnum("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).default(
      sql`clock_timestamp()`,
    ),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastErrorDetail: varchar("last_error_detail", { length: 2000 }),
  },
  (table) => ({
    providerEventKeyUq: uniqueIndex(
      "sms_provider_events_provider_event_key_uq",
    ).on(table.provider, table.eventKey),
    dueIdx: index("sms_provider_events_due_idx")
      .on(table.nextAttemptAt, table.receivedAt, table.id)
      .where(sql`${table.state} in ('pending', 'retry')`),
    practiceIdx: index("sms_provider_events_practice_idx")
      .on(table.practiceId, table.state, table.receivedAt, table.id)
      .where(sql`${table.practiceId} is not null`),
    blockedIdx: index("sms_provider_events_blocked_idx")
      .on(table.practiceId, table.receivedAt, table.id)
      .where(sql`${table.state} = 'blocked_recovery'`),
    providerMessageIdx: index("sms_provider_events_provider_message_idx")
      .on(table.provider, table.providerMessageId, table.receivedAt, table.id)
      .where(sql`${table.providerMessageId} is not null`),
    consentOrderIdx: index("sms_provider_events_consent_order_idx")
      .on(
        table.practiceId,
        table.fromE164,
        sql`coalesce(${table.occurredAt}, ${table.receivedAt})`,
        table.receivedAt,
        table.id,
      )
      .where(
        sql`${table.kind} = 'inbound'
          and ${table.inboundClassification} in ('stop', 'start')
          and ${table.practiceId} is not null
          and ${table.fromE164} is not null`,
      ),
    locationIdx: index("sms_provider_events_location_idx")
      .on(table.practiceId, table.locationId, table.receivedAt, table.id)
      .where(sql`${table.locationId} is not null`),
    locationTenantFk: foreignKey({
      columns: [table.practiceId, table.locationId],
      foreignColumns: [locations.practiceId, locations.id],
      name: "sms_provider_events_location_tenant_fk",
    }),
    providerCheck: check(
      "sms_provider_events_provider_check",
      sql`${table.provider} in ('telnyx', 'twilio')`,
    ),
    identifiersCheck: check(
      "sms_provider_events_identifiers_check",
      sql`(${table.providerEventId} is null or (
          ${table.providerEventId} = btrim(${table.providerEventId})
          and length(${table.providerEventId}) between 1 and 255
        ))
        and (${table.providerMessageId} is null or (
          ${table.providerMessageId} = btrim(${table.providerMessageId})
          and length(${table.providerMessageId}) between 1 and 255
        ))
        and length(btrim(${table.providerEventType})) between 1 and 80
        and ${table.providerEventType} ~ '^[A-Za-z0-9_.:-]+$'
        and length(${table.eventKey}) between 1 and 255
        and ${table.eventKey} ~ '^[A-Za-z0-9_.:-]+$'
        and ${table.rawBodyFingerprintSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    e164Check: check(
      "sms_provider_events_e164_check",
      sql`(${table.fromE164} is null or ${table.fromE164} ~ '^\\+[1-9][0-9]{7,14}$')
        and (${table.toE164} is null or ${table.toE164} ~ '^\\+[1-9][0-9]{7,14}$')
        and (${table.a2pPhoneE164} is null or ${table.a2pPhoneE164} ~ '^\\+[1-9][0-9]{7,14}$')`,
    ),
    boundedFactsCheck: check(
      "sms_provider_events_bounded_facts_check",
      sql`(${table.messagingProfileId} is null or (
          ${table.messagingProfileId} = btrim(${table.messagingProfileId})
          and length(${table.messagingProfileId}) between 1 and 128
        ))
        and (${table.providerStatus} is null or (
          length(btrim(${table.providerStatus})) between 1 and 80
          and ${table.providerStatus} ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and (${table.providerErrorCode} is null or (
          length(btrim(${table.providerErrorCode})) between 1 and 80
          and ${table.providerErrorCode} ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and (${table.a2pBrandId} is null or (
          ${table.a2pBrandId} = btrim(${table.a2pBrandId})
          and length(${table.a2pBrandId}) between 1 and 128
        ))
        and (${table.a2pCampaignId} is null or (
          ${table.a2pCampaignId} = btrim(${table.a2pCampaignId})
          and length(${table.a2pCampaignId}) between 1 and 128
        ))
        and (${table.a2pStatus} is null or (
          length(btrim(${table.a2pStatus})) between 1 and 80
          and ${table.a2pStatus} ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and (${table.a2pType} is null or (
          length(btrim(${table.a2pType})) between 1 and 80
          and ${table.a2pType} ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and (${table.a2pEventType} is null or (
          length(btrim(${table.a2pEventType})) between 1 and 80
          and ${table.a2pEventType} ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and (${table.providerDetail} is null or length(btrim(${table.providerDetail})) between 1 and 1000)
        and (${table.lastErrorCode} is null or (
          length(btrim(${table.lastErrorCode})) between 1 and 64
          and ${table.lastErrorCode} ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and (${table.lastErrorDetail} is null or length(btrim(${table.lastErrorDetail})) between 1 and 2000)`,
    ),
    attributionCheck: check(
      "sms_provider_events_attribution_check",
      sql`${table.locationId} is null or ${table.practiceId} is not null`,
    ),
    kindShapeCheck: check(
      "sms_provider_events_kind_shape_check",
      sql`(
          ${table.kind} = 'inbound'
          and ${table.providerEventType} = 'message.received'
          and ${table.providerMessageId} is not null
          and ${table.fromE164} is not null
          and (${table.toE164} is not null or ${table.messagingProfileId} is not null)
          and ${table.messageBody} is not null
          and length(btrim(${table.messageBody})) >= 1
          and length(${table.messageBody}) <= 1600
          and ${table.inboundClassification} is not null
          and ${table.deliveryClassification} is null
          and ${table.providerStatus} is null
          and ${table.providerErrorCode} is null
          and ${table.a2pBrandId} is null
          and ${table.a2pCampaignId} is null
          and ${table.a2pPhoneE164} is null
          and ${table.a2pStatus} is null
          and ${table.a2pType} is null
          and ${table.a2pEventType} is null
          and ${table.a2pObservedStatus} is null
          and ${table.providerDetail} is null
        ) or (
          ${table.kind} = 'delivery'
          and ${table.providerEventType} like 'message.%'
          and ${table.providerEventType} <> 'message.received'
          and ${table.providerMessageId} is not null
          and ${table.fromE164} is null
          and ${table.toE164} is null
          and ${table.messagingProfileId} is null
          and ${table.messageBody} is null
          and ${table.inboundClassification} is null
          and ${table.deliveryClassification} is not null
          and ${table.a2pBrandId} is null
          and ${table.a2pCampaignId} is null
          and ${table.a2pPhoneE164} is null
          and ${table.a2pStatus} is null
          and ${table.a2pType} is null
          and ${table.a2pEventType} is null
          and ${table.a2pObservedStatus} is null
          and ${table.providerDetail} is null
        ) or (
          ${table.kind} = 'a2p'
          and ${table.provider} = 'telnyx'
          and ${table.providerEventType} in (
            '10dlc.brand.update',
            '10dlc.campaign.update',
            '10dlc.phone_number.update'
          )
          and (
            ${table.a2pBrandId} is not null
            or ${table.a2pCampaignId} is not null
            or ${table.a2pPhoneE164} is not null
          )
          and ${table.a2pObservedStatus} is not null
          and ${table.a2pObservedStatus} in ('pending', 'action_required', 'failed', 'suspended')
          and ${table.providerMessageId} is null
          and ${table.fromE164} is null
          and ${table.toE164} is null
          and ${table.messagingProfileId} is null
          and ${table.messageBody} is null
          and ${table.inboundClassification} is null
          and ${table.deliveryClassification} is null
          and ${table.providerErrorCode} is null
        )`,
    ),
    stateShapeCheck: check(
      "sms_provider_events_state_shape_check",
      sql`${table.attemptCount} >= 0 and (
        (
          ${table.state} = 'pending'
          and ${table.attemptCount} = 0
          and ${table.nextAttemptAt} is not null
          and ${table.nextAttemptAt} >= ${table.receivedAt}
          and ${table.lastAttemptAt} is null
          and ${table.processedAt} is null
          and ${table.lastErrorCode} is null
          and ${table.lastErrorDetail} is null
        ) or (
          ${table.state} = 'retry'
          and ${table.attemptCount} >= 1
          and ${table.nextAttemptAt} is not null
          and ${table.lastAttemptAt} is not null
          and ${table.lastAttemptAt} >= ${table.receivedAt}
          and ${table.nextAttemptAt} > ${table.lastAttemptAt}
          and ${table.processedAt} is null
          and ${table.lastErrorCode} is not null
        ) or (
          ${table.state} = 'blocked_recovery'
          and ${table.practiceId} is not null
          and ${table.attemptCount} >= 1
          and ${table.nextAttemptAt} is null
          and ${table.lastAttemptAt} is not null
          and ${table.lastAttemptAt} >= ${table.receivedAt}
          and ${table.processedAt} is null
        ) or (
          ${table.state} = 'projected'
          and (${table.practiceId} is not null or ${table.kind} = 'delivery')
          and ${table.attemptCount} >= 1
          and ${table.nextAttemptAt} is null
          and ${table.lastAttemptAt} is not null
          and ${table.lastAttemptAt} >= ${table.receivedAt}
          and ${table.processedAt} is not null
          and ${table.processedAt} >= ${table.lastAttemptAt}
          and ${table.lastErrorCode} is null
          and ${table.lastErrorDetail} is null
        ) or (
          ${table.state} = 'ignored'
          and ${table.attemptCount} >= 1
          and ${table.nextAttemptAt} is null
          and ${table.lastAttemptAt} is not null
          and ${table.lastAttemptAt} >= ${table.receivedAt}
          and ${table.processedAt} is not null
          and ${table.processedAt} >= ${table.lastAttemptAt}
          and ${table.lastErrorCode} is null
          and ${table.lastErrorDetail} is null
        ) or (
          ${table.state} = 'quarantined'
          and ${table.attemptCount} >= 1
          and ${table.nextAttemptAt} is null
          and ${table.lastAttemptAt} is not null
          and ${table.lastAttemptAt} >= ${table.receivedAt}
          and ${table.processedAt} is not null
          and ${table.processedAt} >= ${table.lastAttemptAt}
          and ${table.lastErrorCode} is not null
        )
      )`,
    ),
  }),
);

/**
 * Append-only evidence that a provider reused an idempotency identity for a
 * different signed body. Payload content and phone numbers are intentionally
 * excluded.
 */
export const smsProviderEventConflicts = pgTable(
  "sms_provider_event_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    originalEventId: uuid("original_event_id")
      .notNull()
      .references(() => smsProviderEvents.id),
    incomingRawBodyFingerprintSha256: varchar(
      "incoming_raw_body_fingerprint_sha256",
      { length: 64 },
    ).notNull(),
    incomingProviderEventType: varchar("incoming_provider_event_type", {
      length: 80,
    }).notNull(),
    incomingProviderEventId: varchar("incoming_provider_event_id", {
      length: 255,
    }),
    incomingProviderMessageId: varchar("incoming_provider_message_id", {
      length: 255,
    }),
  },
  (table) => ({
    identityUq: uniqueIndex("sms_provider_event_conflicts_identity_uq").on(
      table.originalEventId,
      table.incomingRawBodyFingerprintSha256,
    ),
    recoveryIdx: index("sms_provider_event_conflicts_recovery_idx").on(
      table.receivedAt,
      table.id,
    ),
    shapeCheck: check(
      "sms_provider_event_conflicts_shape_check",
      sql`${table.incomingRawBodyFingerprintSha256} ~ '^[0-9a-f]{64}$'
        and length(btrim(${table.incomingProviderEventType})) between 1 and 80
        and ${table.incomingProviderEventType} ~ '^[A-Za-z0-9_.:-]+$'
        and (${table.incomingProviderEventId} is null or (
          ${table.incomingProviderEventId} = btrim(${table.incomingProviderEventId})
          and length(${table.incomingProviderEventId}) between 1 and 255
        ))
        and (${table.incomingProviderMessageId} is null or (
          ${table.incomingProviderMessageId} = btrim(${table.incomingProviderMessageId})
          and length(${table.incomingProviderMessageId}) between 1 and 255
        ))`,
    ),
  }),
);

/**
 * One terminal, append-only operator review for a conflicting provider fact.
 * Every resolution means the conflicting callback is never projected. The
 * operation identifier makes an operator retry idempotent without mutation.
 */
export const smsProviderEventConflictReviews = pgTable(
  "sms_provider_event_conflict_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    conflictId: uuid("conflict_id")
      .notNull()
      .references(() => smsProviderEventConflicts.id),
    operationId: uuid("operation_id").notNull(),
    resolution: smsProviderEventConflictResolutionEnum("resolution").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    detail: varchar("detail", { length: 2000 }),
    reviewedByIdentity: varchar("reviewed_by_identity", {
      length: 255,
    }).notNull(),
    reviewedByName: varchar("reviewed_by_name", { length: 255 }).notNull(),
  },
  (table) => ({
    conflictUq: uniqueIndex(
      "sms_provider_event_conflict_reviews_conflict_uq",
    ).on(table.conflictId),
    operationUq: uniqueIndex(
      "sms_provider_event_conflict_reviews_operation_uq",
    ).on(table.operationId),
    historyIdx: index("sms_provider_event_conflict_reviews_history_idx").on(
      table.reviewedAt,
      table.id,
    ),
    shapeCheck: check(
      "sms_provider_event_conflict_reviews_shape_check",
      sql`(
          (${table.resolution} = 'semantic_duplicate_confirmed' and ${table.reasonCode} in (
            'provider_replay_verified', 'signature_evidence_verified'
          ))
          or (${table.resolution} = 'provider_identity_rotated' and ${table.reasonCode} in (
            'sender_identity_rotated', 'provider_identity_reprovisioned'
          ))
          or (${table.resolution} = 'incident_closed_no_projection' and ${table.reasonCode} in (
            'provider_support_incident_closed', 'security_review_closed'
          ))
        )
        and ${table.reviewedByIdentity} = btrim(${table.reviewedByIdentity})
        and length(${table.reviewedByIdentity}) between 1 and 255
        and ${table.reviewedByName} = btrim(${table.reviewedByName})
        and length(${table.reviewedByName}) between 1 and 255
        and (${table.detail} is null or length(btrim(${table.detail})) between 1 and 2000)`,
    ),
  }),
);

/**
 * Append-only, system-only evidence that a terminal provider incident has been
 * handled. Base rows cover a non-conflict quarantine; conflict-scoped rows also
 * cover conflicts appended after projection. The ledger never changes the
 * inbox event itself: callers must present durable evidence.
 */
export const smsProviderEventResolutions = pgTable(
  "sms_provider_event_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    eventId: uuid("event_id")
      .notNull()
      .references(() => smsProviderEvents.id),
    conflictId: uuid("conflict_id").references(
      () => smsProviderEventConflicts.id,
    ),
    operationId: uuid("operation_id").notNull(),
    practiceId: uuid("practice_id").references(() => practices.id),
    resolution: smsProviderEventResolutionEnum("resolution").notNull(),
    inboundCommunicationId: uuid("inbound_communication_id").references(
      () => communications.id,
    ),
    smsConsentEventId: uuid("sms_consent_event_id").references(
      () => smsConsentEvents.id,
    ),
    smsDeliveryEventId: uuid("sms_delivery_event_id").references(
      () => smsDeliveryEvents.id,
    ),
    messagingRegistrationEventId: uuid(
      "messaging_registration_event_id",
    ).references(() => messagingRegistrationEvents.id),
    externalEvidenceReference: varchar("external_evidence_reference", {
      length: 255,
    }),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
    detail: varchar("detail", { length: 2000 }),
    resolvedByIdentity: varchar("resolved_by_identity", {
      length: 255,
    }).notNull(),
    resolvedByName: varchar("resolved_by_name", { length: 255 }).notNull(),
  },
  (table) => ({
    baseEventUq: uniqueIndex("sms_provider_event_resolutions_base_event_uq")
      .on(table.eventId)
      .where(sql`${table.conflictId} is null`),
    eventIdx: index("sms_provider_event_resolutions_event_idx").on(
      table.eventId,
      table.resolvedAt,
      table.id,
    ),
    conflictUq: uniqueIndex("sms_provider_event_resolutions_conflict_uq").on(
      table.conflictId,
    ),
    operationUq: uniqueIndex("sms_provider_event_resolutions_operation_uq").on(
      table.operationId,
    ),
    practiceHistoryIdx: index(
      "sms_provider_event_resolutions_practice_history_idx",
    ).on(table.practiceId, table.resolvedAt, table.id),
    communicationEvidenceIdx: index(
      "sms_provider_event_resolutions_communication_evidence_idx",
    )
      .on(table.inboundCommunicationId)
      .where(sql`${table.inboundCommunicationId} is not null`),
    consentEvidenceIdx: index(
      "sms_provider_event_resolutions_consent_evidence_idx",
    )
      .on(table.smsConsentEventId)
      .where(sql`${table.smsConsentEventId} is not null`),
    deliveryEvidenceIdx: index(
      "sms_provider_event_resolutions_delivery_evidence_idx",
    )
      .on(table.smsDeliveryEventId)
      .where(sql`${table.smsDeliveryEventId} is not null`),
    registrationEvidenceIdx: index(
      "sms_provider_event_resolutions_registration_evidence_idx",
    )
      .on(table.messagingRegistrationEventId)
      .where(sql`${table.messagingRegistrationEventId} is not null`),
    shapeCheck: check(
      "sms_provider_event_resolutions_shape_check",
      sql`${table.reasonCode} ~ '^[a-z0-9_]{3,64}$'
        and (${table.resolution} = 'provider_attested_no_projection' or ${table.practiceId} is not null)
        and (
          (${table.resolution} = 'authoritative_projection' and ${table.reasonCode} in (
            'projection_repaired', 'delivery_reconciled'
          ))
          or (${table.resolution} = 'conservative_opt_out' and ${table.reasonCode} in (
            'provider_identity_conflict_opt_out', 'sender_identity_drift_opt_out'
          ))
          or (${table.resolution} = 'carrier_state_reconciled'
            and ${table.reasonCode} = 'carrier_state_readback_confirmed')
          or (${table.resolution} = 'provider_attested_no_projection' and ${table.reasonCode} in (
            'provider_support_invalid_callback', 'provider_support_duplicate_callback'
          ))
        )
        and ${table.resolvedByIdentity} = btrim(${table.resolvedByIdentity})
        and length(${table.resolvedByIdentity}) between 1 and 255
        and ${table.resolvedByName} = btrim(${table.resolvedByName})
        and length(${table.resolvedByName}) between 1 and 255
        and (${table.detail} is null or length(btrim(${table.detail})) between 1 and 2000)
        and (${table.externalEvidenceReference} is null or (
          ${table.externalEvidenceReference} = btrim(${table.externalEvidenceReference})
          and length(${table.externalEvidenceReference}) between 3 and 255
          and ${table.externalEvidenceReference} ~ '^[A-Za-z0-9][A-Za-z0-9_.:/#-]{2,254}$'
        ))
        and (
          (${table.resolution} = 'authoritative_projection'
            and ${table.externalEvidenceReference} is null
            and num_nonnulls(
              ${table.inboundCommunicationId},
              ${table.smsConsentEventId},
              ${table.smsDeliveryEventId},
              ${table.messagingRegistrationEventId}
            ) between 1 and 2)
          or (${table.resolution} = 'conservative_opt_out'
            and ${table.inboundCommunicationId} is null
            and ${table.smsConsentEventId} is not null
            and ${table.smsDeliveryEventId} is null
            and ${table.messagingRegistrationEventId} is null
            and ${table.externalEvidenceReference} is null)
          or (${table.resolution} = 'carrier_state_reconciled'
            and ${table.inboundCommunicationId} is null
            and ${table.smsConsentEventId} is null
            and ${table.smsDeliveryEventId} is null
            and ${table.messagingRegistrationEventId} is not null
            and ${table.externalEvidenceReference} is null)
          or (${table.resolution} = 'provider_attested_no_projection'
            and ${table.inboundCommunicationId} is null
            and ${table.smsConsentEventId} is null
            and ${table.smsDeliveryEventId} is null
            and ${table.messagingRegistrationEventId} is null
            and ${table.externalEvidenceReference} is not null)
        )`,
    ),
  }),
);
