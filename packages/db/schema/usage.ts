import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
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
    processedAt: timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // checkout.session.completed is intentionally delivered to both the
    // subscription and client-invoice endpoints. Each endpoint must claim it
    // independently; redelivery to the same endpoint remains idempotent.
    pk: primaryKey({ columns: [table.eventId, table.endpoint] }),
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
