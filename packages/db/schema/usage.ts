import {
  check,
  pgTable,
  pgEnum,
  uuid,
  varchar,
  integer,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";

/**
 * Metered usage events for the hosted service (SMS sends, AI agent runs). Rolled
 * up per billing period to charge overage beyond a plan's included allowance.
 * Practice-scoped → covered by RLS (see packages/db/rls/enable-rls.sql).
 * Only written when HOSTED_BILLING_ENABLED — self-host never meters.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    /** "sms" | "ai_run" */
    kind: varchar("kind", { length: 16 }).notNull(),
    quantity: integer("quantity").notNull().default(1),
    /** Billing period as YYYY-MM (UTC). */
    periodMonth: varchar("period_month", { length: 7 }).notNull(),
    /** Stable Stripe meter-event identifier, derived from this row id. */
    stripeMeterIdentifier: varchar("stripe_meter_identifier", { length: 128 }),
    /** Set after the matching Stripe meter event is accepted. */
    stripeMeteredAt: timestamp("stripe_metered_at", { withTimezone: true }),
  },
  (t) => ({
    practicePeriodIdx: index("usage_practice_period_idx").on(
      t.practiceId,
      t.periodMonth
    ),
    meterRetryIdx: index("usage_meter_retry_idx").on(t.stripeMeteredAt),
  })
);

export const stripeConversionEvidenceKindEnum = pgEnum(
  "stripe_conversion_evidence_kind",
  [
    "subscription_checkout_completed",
    "positive_subscription_invoice_paid",
  ],
);

/**
 * Durable de-dup ledger for Stripe webhooks. Cross-tenant/system table: webhook
 * handlers insert an event id + endpoint inside the same transaction as side
 * effects; a duplicate pair means that endpoint already processed the event.
 */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    eventId: varchar("event_id", { length: 128 }).notNull(),
    endpoint: varchar("endpoint", { length: 64 }).notNull(),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    /** Stripe's signed event.created timestamp. Null only on legacy claims. */
    eventCreatedAt: timestamp("event_created_at", { withTimezone: true }),
    /** Resolved active practice. Null means the evidence could not be mapped. */
    practiceId: uuid("practice_id").references(() => practices.id),
    /** Allowlisted Checkout Session / Invoice object id; never the raw payload. */
    objectId: varchar("object_id", { length: 128 }),
    evidenceKind: stripeConversionEvidenceKindEnum("evidence_kind"),
    /** Positive subscription invoice amount in integer minor currency units. */
    amountCents: integer("amount_cents"),
    /** Lower-case ISO 4217 code, only for positive invoice evidence. */
    currency: varchar("currency", { length: 3 }),
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // checkout.session.completed is intentionally delivered to both the
    // subscription and client-invoice endpoints. Each endpoint must claim it
    // independently; redelivery to the same endpoint remains idempotent.
    pk: primaryKey({ columns: [table.eventId, table.endpoint] }),
    conversionEvidenceIdx: index("stripe_events_conversion_evidence_idx")
      .on(
        table.evidenceKind,
        table.practiceId,
        table.eventCreatedAt,
        table.eventId,
      )
      .where(sql`${table.evidenceKind} is not null`),
    evidenceShapeCheck: check(
      "stripe_events_conversion_evidence_shape_check",
      sql`(
        ${table.evidenceKind} is null and
        ${table.eventCreatedAt} is null and
        ${table.objectId} is null and
        ${table.amountCents} is null and
        ${table.currency} is null
      ) or (
        ${table.evidenceKind} is not null and
        ${table.eventCreatedAt} is not null and
        ${table.objectId} is not null and
        length(btrim(${table.objectId})) > 0 and
        (
          (${table.evidenceKind} = 'subscription_checkout_completed' and
            ${table.amountCents} is null and ${table.currency} is null) or
          (${table.evidenceKind} = 'positive_subscription_invoice_paid' and
            ${table.amountCents} is not null and ${table.amountCents} > 0 and
            ${table.currency} is not null and
            ${table.currency} ~ '^[a-z]{3}$')
        )
      )`,
    ),
  })
);

/**
 * Durable fixed-window rate-limit buckets. Global/system state because many
 * protected surfaces are pre-auth or cross-tenant (login, registration, API key
 * auth, portal booking).
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: varchar("key", { length: 255 }).primaryKey(),
    count: integer("count").notNull().default(0),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    resetAtIdx: index("rate_limit_buckets_reset_at_idx").on(table.resetAt),
  })
);
