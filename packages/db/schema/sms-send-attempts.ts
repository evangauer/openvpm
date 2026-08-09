import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { clients } from "./clients";
import { communications } from "./communications";
import { locations, practices } from "./practices";
import { users } from "./users";

export const smsSendOutcomeEnum = pgEnum("sms_send_outcome", [
  "accepted",
  "definite_failure",
  "outcome_unknown",
]);

export const smsSendAttemptEventKindEnum = pgEnum(
  "sms_send_attempt_event_kind",
  ["provider_result", "reconciliation"],
);

export const smsSendActorTypeEnum = pgEnum("sms_send_actor_type", [
  "clinic_user",
  "platform_operator",
]);

/**
 * Immutable reservation and exact payload for one provider dispatch. The row is
 * committed before the provider call, so a crash can leave an unresolved
 * attempt but can never erase the idempotency claim and invite a blind retry.
 */
export const smsSendAttempts = pgTable(
  "sms_send_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id").references(() => clients.id),
    locationId: uuid("location_id").references(() => locations.id),
    communicationId: uuid("communication_id").references(
      () => communications.id,
    ),
    requestedByActorType: smsSendActorTypeEnum("requested_by_actor_type"),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
    requestedByIdentity: varchar("requested_by_identity", { length: 255 }),
    requestedByName: varchar("requested_by_name", { length: 255 }),
    resendOfAttemptId: uuid("resend_of_attempt_id"),
    source: varchar("source", { length: 64 }).notNull(),
    sourceId: varchar("source_id", { length: 200 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    destinationE164: varchar("destination_e164", { length: 16 }).notNull(),
    registeredDisplayName: varchar("registered_display_name", {
      length: 100,
    }).notNull(),
    body: text("body").notNull(),
    bodySha256: varchar("body_sha256", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    senderMessagingServiceId: varchar("sender_messaging_service_id", {
      length: 128,
    }),
    senderE164: varchar("sender_e164", { length: 16 }),
  },
  (table) => ({
    tenantIdUq: uniqueIndex("sms_send_attempts_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    idempotencyUq: uniqueIndex("sms_send_attempts_practice_idempotency_uq").on(
      table.practiceId,
      table.idempotencyKey,
    ),
    resendOfUq: uniqueIndex("sms_send_attempts_resend_of_uq")
      .on(table.practiceId, table.resendOfAttemptId)
      .where(sql`${table.resendOfAttemptId} is not null`),
    clientHistoryIdx: index("sms_send_attempts_client_history_idx").on(
      table.practiceId,
      table.clientId,
      table.createdAt,
      table.id,
    ),
    communicationIdx: index("sms_send_attempts_communication_idx").on(
      table.practiceId,
      table.communicationId,
    ),
    sourceHistoryIdx: index("sms_send_attempts_source_history_idx").on(
      table.practiceId,
      table.source,
      table.sourceId,
      table.createdAt,
    ),
    resendTenantFk: foreignKey({
      columns: [table.practiceId, table.resendOfAttemptId],
      foreignColumns: [table.practiceId, table.id],
      name: "sms_send_attempts_resend_tenant_fk",
    }),
    clientTenantFk: foreignKey({
      columns: [table.practiceId, table.clientId],
      foreignColumns: [clients.practiceId, clients.id],
      name: "sms_send_attempts_client_tenant_fk",
    }),
    locationTenantFk: foreignKey({
      columns: [table.practiceId, table.locationId],
      foreignColumns: [locations.practiceId, locations.id],
      name: "sms_send_attempts_location_tenant_fk",
    }),
    communicationTenantFk: foreignKey({
      columns: [table.practiceId, table.communicationId],
      foreignColumns: [communications.practiceId, communications.id],
      name: "sms_send_attempts_communication_tenant_fk",
    }),
    requesterTenantFk: foreignKey({
      columns: [table.practiceId, table.requestedByUserId],
      foreignColumns: [users.practiceId, users.id],
      name: "sms_send_attempts_requester_tenant_fk",
    }),
    sourceCheck: check(
      "sms_send_attempts_source_check",
      sql`length(btrim(${table.source})) between 1 and 64`,
    ),
    sourceIdCheck: check(
      "sms_send_attempts_source_id_check",
      sql`length(btrim(${table.sourceId})) between 1 and 200`,
    ),
    idempotencyCheck: check(
      "sms_send_attempts_idempotency_key_check",
      sql`length(btrim(${table.idempotencyKey})) between 1 and 200`,
    ),
    destinationCheck: check(
      "sms_send_attempts_destination_check",
      sql`${table.destinationE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    destinationHistoryIdx: index(
      "sms_send_attempts_destination_history_idx",
    ).on(table.practiceId, table.destinationE164, table.createdAt, table.id),
    displayNameCheck: check(
      "sms_send_attempts_display_name_check",
      sql`length(btrim(${table.registeredDisplayName})) between 1 and 100`,
    ),
    bodyCheck: check(
      "sms_send_attempts_body_check",
      sql`length(${table.body}) between 1 and 1600`,
    ),
    bodyHashCheck: check(
      "sms_send_attempts_body_hash_check",
      sql`${table.bodySha256} ~ '^[0-9a-f]{64}$'`,
    ),
    providerCheck: check(
      "sms_send_attempts_provider_check",
      sql`${table.provider} in ('telnyx', 'twilio', 'console')`,
    ),
    senderCheck: check(
      "sms_send_attempts_sender_check",
      sql`${table.provider} = 'console'
        or length(btrim(coalesce(${table.senderMessagingServiceId}, ''))) > 0
        or ${table.senderE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    requesterCheck: check(
      "sms_send_attempts_requester_check",
      sql`(
          ${table.source} = 'operator_resend'
          and ${table.requestedByActorType} is not null
          and length(btrim(coalesce(${table.requestedByIdentity}, ''))) between 1 and 255
          and length(btrim(coalesce(${table.requestedByName}, ''))) between 1 and 255
          and (
            (${table.requestedByActorType} = 'clinic_user' and ${table.requestedByUserId} is not null)
            or (${table.requestedByActorType} = 'platform_operator' and ${table.requestedByUserId} is null)
          )
        ) or (
          ${table.source} <> 'operator_resend'
          and (
            (
              ${table.requestedByActorType} is null
              and ${table.requestedByUserId} is null
              and ${table.requestedByIdentity} is null
              and ${table.requestedByName} is null
            )
            or (
              ${table.requestedByActorType} is not null
              and length(btrim(coalesce(${table.requestedByIdentity}, ''))) between 1 and 255
              and length(btrim(coalesce(${table.requestedByName}, ''))) between 1 and 255
              and (
                (${table.requestedByActorType} = 'clinic_user' and ${table.requestedByUserId} is not null)
                or (${table.requestedByActorType} = 'platform_operator' and ${table.requestedByUserId} is null)
              )
            )
          )
        )`,
    ),
  }),
);

/** Append-only provider outcomes and operator reconciliations for an attempt. */
export const smsSendAttemptEvents = pgTable(
  "sms_send_attempt_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    attemptId: uuid("attempt_id").notNull(),
    kind: smsSendAttemptEventKindEnum("kind").notNull(),
    outcome: smsSendOutcomeEnum("outcome").notNull(),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    detail: text("detail"),
    actorType: smsSendActorTypeEnum("actor_type"),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorIdentity: varchar("actor_identity", { length: 255 }),
    actorName: varchar("actor_name", { length: 255 }),
    eventKey: varchar("event_key", { length: 200 }).notNull(),
  },
  (table) => ({
    eventKeyUq: uniqueIndex("sms_send_attempt_events_practice_event_key_uq").on(
      table.practiceId,
      table.eventKey,
    ),
    providerResultUq: uniqueIndex("sms_send_attempt_events_provider_result_uq")
      .on(table.practiceId, table.attemptId)
      .where(sql`${table.kind} = 'provider_result'`),
    attemptHistoryIdx: index("sms_send_attempt_events_attempt_history_idx").on(
      table.practiceId,
      table.attemptId,
      table.createdAt,
      table.id,
    ),
    providerMessageUq: uniqueIndex(
      "sms_send_attempt_events_provider_message_uq",
    )
      .on(table.practiceId, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    attemptTenantFk: foreignKey({
      columns: [table.practiceId, table.attemptId],
      foreignColumns: [smsSendAttempts.practiceId, smsSendAttempts.id],
      name: "sms_send_attempt_events_attempt_tenant_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorUserId],
      foreignColumns: [users.practiceId, users.id],
      name: "sms_send_attempt_events_actor_tenant_fk",
    }),
    eventKeyCheck: check(
      "sms_send_attempt_events_event_key_check",
      sql`length(btrim(${table.eventKey})) between 1 and 200`,
    ),
    detailCheck: check(
      "sms_send_attempt_events_detail_check",
      sql`${table.detail} is null or length(${table.detail}) <= 2000`,
    ),
    outcomeShapeCheck: check(
      "sms_send_attempt_events_outcome_shape_check",
      sql`(
          ${table.outcome} = 'accepted'
          and length(btrim(coalesce(${table.providerMessageId}, ''))) > 0
        ) or (
          ${table.outcome} in ('definite_failure', 'outcome_unknown')
          and ${table.providerMessageId} is null
        )`,
    ),
    actorShapeCheck: check(
      "sms_send_attempt_events_actor_shape_check",
      sql`(
          ${table.kind} = 'provider_result'
          and ${table.actorType} is null
          and ${table.actorUserId} is null
          and ${table.actorIdentity} is null
          and ${table.actorName} is null
        ) or (
          ${table.kind} = 'reconciliation'
          and ${table.outcome} in ('accepted', 'definite_failure')
          and ${table.actorType} is not null
          and length(btrim(coalesce(${table.actorIdentity}, ''))) between 1 and 255
          and length(btrim(coalesce(${table.actorName}, ''))) between 1 and 255
          and (
            (${table.actorType} = 'clinic_user' and ${table.actorUserId} is not null)
            or (${table.actorType} = 'platform_operator' and ${table.actorUserId} is null)
          )
        )`,
    ),
  }),
);

export const smsSendAttemptsRelations = relations(
  smsSendAttempts,
  ({ one, many }) => ({
    practice: one(practices, {
      fields: [smsSendAttempts.practiceId],
      references: [practices.id],
    }),
    client: one(clients, {
      fields: [smsSendAttempts.clientId],
      references: [clients.id],
    }),
    location: one(locations, {
      fields: [smsSendAttempts.locationId],
      references: [locations.id],
    }),
    communication: one(communications, {
      fields: [smsSendAttempts.communicationId],
      references: [communications.id],
    }),
    requester: one(users, {
      fields: [smsSendAttempts.requestedByUserId],
      references: [users.id],
    }),
    resendOf: one(smsSendAttempts, {
      fields: [smsSendAttempts.resendOfAttemptId],
      references: [smsSendAttempts.id],
      relationName: "smsAttemptResends",
    }),
    resends: many(smsSendAttempts, { relationName: "smsAttemptResends" }),
    events: many(smsSendAttemptEvents),
  }),
);

export const smsSendAttemptEventsRelations = relations(
  smsSendAttemptEvents,
  ({ one }) => ({
    practice: one(practices, {
      fields: [smsSendAttemptEvents.practiceId],
      references: [practices.id],
    }),
    attempt: one(smsSendAttempts, {
      fields: [smsSendAttemptEvents.attemptId],
      references: [smsSendAttempts.id],
    }),
    actor: one(users, {
      fields: [smsSendAttemptEvents.actorUserId],
      references: [users.id],
    }),
  }),
);
