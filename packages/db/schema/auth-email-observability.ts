import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";
import { users } from "./users";

export const authEmailSourceEnum = pgEnum("auth_email_source", [
  "registration",
  "authenticated_resend",
]);

export const authEmailAttemptOutcomeEnum = pgEnum(
  "auth_email_attempt_outcome",
  ["reserved", "accepted", "definite_failure", "outcome_unknown"],
);

export const authEmailDeliveryClassificationEnum = pgEnum(
  "auth_email_delivery_classification",
  [
    "sent",
    "delivered",
    "delayed",
    "failed",
    "complained",
    "opened",
    "clicked",
    "unknown",
  ],
);

export const authEmailDeliveryAttributionEnum = pgEnum(
  "auth_email_delivery_attribution",
  ["attempt_tag", "provider_message_id", "unmatched", "identity_conflict"],
);

/**
 * One reserved verification-email dispatch. The reservation is committed
 * before the provider call and then advanced to an explicit provider outcome.
 * It intentionally contains no recipient, token, URL, subject, or body copy.
 */
export const authEmailAttempts = pgTable(
  "auth_email_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: uuid("user_id").notNull(),
    source: authEmailSourceEnum("source").notNull(),
    provider: varchar("provider", { length: 16 }).notNull().default("resend"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 128 }),
    outcome: authEmailAttemptOutcomeEnum("outcome")
      .notNull()
      .default("reserved"),
    failureCode: varchar("failure_code", { length: 64 }),
  },
  (table) => ({
    userTenantFk: foreignKey({
      columns: [table.practiceId, table.userId],
      foreignColumns: [users.practiceId, users.id],
      name: "auth_email_attempts_user_tenant_fk",
    }),
    idempotencyUq: uniqueIndex("auth_email_attempts_idempotency_uq").on(
      table.idempotencyKey,
    ),
    providerMessageUq: uniqueIndex("auth_email_attempts_provider_message_uq")
      .on(table.provider, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    recoveryIdx: index("auth_email_attempts_recovery_idx").on(
      table.outcome,
      table.createdAt,
      table.id,
    ),
    practiceCreatedIdx: index("auth_email_attempts_practice_created_idx").on(
      table.practiceId,
      table.createdAt,
      table.id,
    ),
    providerCheck: check(
      "auth_email_attempts_provider_check",
      sql`${table.provider} in ('resend', 'console')`,
    ),
    outcomeShapeCheck: check(
      "auth_email_attempts_outcome_shape_check",
      sql`(
        ${table.outcome} = 'reserved'
        and ${table.resolvedAt} is null
        and ${table.providerMessageId} is null
        and ${table.failureCode} is null
      ) or (
        ${table.outcome} = 'accepted'
        and ${table.resolvedAt} is not null
        and length(btrim(coalesce(${table.providerMessageId}, ''))) > 0
        and ${table.failureCode} is null
      ) or (
        ${table.outcome} in ('definite_failure', 'outcome_unknown')
        and ${table.resolvedAt} is not null
        and ${table.providerMessageId} is null
        and length(btrim(coalesce(${table.failureCode}, ''))) > 0
      )`,
    ),
  }),
);

/** Append-only evidence that the API and signed callback observed two ids. */
export const authEmailProviderIdentityConflicts = pgTable(
  "auth_email_provider_identity_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attemptId: uuid("attempt_id").notNull(),
    provider: varchar("provider", { length: 16 }).notNull().default("resend"),
    source: authEmailSourceEnum("source").notNull(),
    durableProviderMessageId: varchar("durable_provider_message_id", {
      length: 128,
    }).notNull(),
    conflictingProviderMessageId: varchar("conflicting_provider_message_id", {
      length: 128,
    }).notNull(),
  },
  (table) => ({
    attemptFk: foreignKey({
      columns: [table.attemptId],
      foreignColumns: [authEmailAttempts.id],
      name: "auth_email_provider_identity_conflicts_attempt_fk",
    }),
    identityUq: uniqueIndex(
      "auth_email_provider_identity_conflicts_identity_uq",
    ).on(
      table.attemptId,
      table.provider,
      table.durableProviderMessageId,
      table.conflictingProviderMessageId,
    ),
    recoveryIdx: index(
      "auth_email_provider_identity_conflicts_recovery_idx",
    ).on(table.occurredAt, table.id),
    providerCheck: check(
      "auth_email_provider_identity_conflicts_provider_check",
      sql`${table.provider} = 'resend'`,
    ),
    distinctIdentityCheck: check(
      "auth_email_provider_identity_conflicts_distinct_id_check",
      sql`${table.durableProviderMessageId} <> ${table.conflictingProviderMessageId}`,
    ),
    identityShapeCheck: check(
      "auth_email_provider_identity_conflicts_id_shape_check",
      sql`length(btrim(${table.durableProviderMessageId})) > 0
        and length(btrim(${table.conflictingProviderMessageId})) > 0`,
    ),
  }),
);

/**
 * Immutable, redacted evidence from a signed Resend webhook. Events may arrive
 * before the send result is persisted, so attribution can be absent while the
 * provider message id still permits a later exact derived match.
 */
export const authEmailDeliveryEvents = pgTable(
  "auth_email_delivery_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    webhookId: varchar("webhook_id", { length: 128 }).notNull(),
    rawBodyFingerprint: varchar("raw_body_fingerprint", {
      length: 64,
    }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull().default("resend"),
    providerMessageId: varchar("provider_message_id", {
      length: 128,
    }).notNull(),
    attemptId: uuid("attempt_id").references(() => authEmailAttempts.id),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    classification:
      authEmailDeliveryClassificationEnum("classification").notNull(),
    attribution: authEmailDeliveryAttributionEnum("attribution").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    webhookUq: uniqueIndex("auth_email_delivery_events_webhook_uq").on(
      table.webhookId,
    ),
    attemptTimelineIdx: index(
      "auth_email_delivery_events_attempt_timeline_idx",
    ).on(table.attemptId, table.occurredAt, table.id),
    providerTimelineIdx: index(
      "auth_email_delivery_events_provider_timeline_idx",
    ).on(table.provider, table.providerMessageId, table.occurredAt, table.id),
    attributionQueueIdx: index(
      "auth_email_delivery_events_attribution_queue_idx",
    ).on(table.attribution, table.receivedAt, table.id),
    providerCheck: check(
      "auth_email_delivery_events_provider_check",
      sql`${table.provider} = 'resend'`,
    ),
    eventTypeCheck: check(
      "auth_email_delivery_events_event_type_check",
      sql`${table.eventType} ~ '^email\\.'`,
    ),
    rawBodyFingerprintCheck: check(
      "auth_email_delivery_events_raw_body_fingerprint_check",
      sql`${table.rawBodyFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    attributionShapeCheck: check(
      "auth_email_delivery_events_attribution_shape_check",
      sql`(
        ${table.attribution} in ('attempt_tag', 'provider_message_id')
        and ${table.attemptId} is not null
      ) or (
        ${table.attribution} in ('unmatched', 'identity_conflict')
        and ${table.attemptId} is null
      )`,
    ),
  }),
);

/**
 * Append-only quarantine for a signed callback that reuses an existing Svix
 * id with a different verified body. Only safe provider identity and SHA-256
 * evidence is retained; message content and recipients are never copied.
 */
export const authEmailWebhookConflicts = pgTable(
  "auth_email_webhook_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    originalWebhookId: varchar("original_webhook_id", {
      length: 128,
    }).notNull(),
    incomingRawBodyFingerprint: varchar("incoming_raw_body_fingerprint", {
      length: 64,
    }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull().default("resend"),
    incomingProviderMessageId: varchar("incoming_provider_message_id", {
      length: 128,
    }).notNull(),
    incomingEventType: varchar("incoming_event_type", { length: 64 }).notNull(),
  },
  (table) => ({
    originalWebhookFk: foreignKey({
      columns: [table.originalWebhookId],
      foreignColumns: [authEmailDeliveryEvents.webhookId],
      name: "auth_email_webhook_conflicts_webhook_fk",
    }),
    identityUq: uniqueIndex("auth_email_webhook_conflicts_identity_uq").on(
      table.originalWebhookId,
      table.incomingRawBodyFingerprint,
    ),
    recoveryIdx: index("auth_email_webhook_conflicts_recovery_idx").on(
      table.receivedAt,
      table.id,
    ),
    providerCheck: check(
      "auth_email_webhook_conflicts_provider_check",
      sql`${table.provider} = 'resend'`,
    ),
    eventTypeCheck: check(
      "auth_email_webhook_conflicts_event_type_check",
      sql`${table.incomingEventType} ~ '^email\\.'`,
    ),
    rawBodyFingerprintCheck: check(
      "auth_email_webhook_conflicts_raw_body_fingerprint_check",
      sql`${table.incomingRawBodyFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
