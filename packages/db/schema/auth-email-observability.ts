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
