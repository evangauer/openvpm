import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";

export const practiceConversionMilestoneEnum = pgEnum(
  "practice_conversion_milestone",
  [
    "registered",
    "activated",
    "payment_method_collected",
    "first_positive_payment",
  ],
);

export const conversionEvidenceSourceEnum = pgEnum(
  "conversion_evidence_source",
  ["practice_created", "product_records", "stripe_webhook"],
);

/**
 * Repairable projection of authoritative, practice-owned conversion facts.
 *
 * This table is deliberately separate from `funnel_events`: browser journey
 * events remain an append-only analytics ledger, while these rows can be
 * reconciled to an earlier exact source timestamp if delayed evidence arrives.
 * `occurred_at` is the business-event time; `observed_at` is only when OpenVPM
 * first projected it and must never be used as a conversion timestamp.
 */
export const practiceConversionMilestones = pgTable(
  "practice_conversion_milestones",
  {
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    milestone: practiceConversionMilestoneEnum("milestone").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    evidenceSource: conversionEvidenceSourceEnum("evidence_source").notNull(),
    /** Stable, non-PII source identity (practice/product UUIDs or Stripe event id). */
    evidenceKey: varchar("evidence_key", { length: 255 }).notNull(),
    /** Present only for first_positive_payment; integer minor currency units. */
    amountCents: integer("amount_cents"),
    /** Lower-case ISO 4217 currency code; present only with amount_cents. */
    currency: varchar("currency", { length: 3 }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.practiceId, table.milestone] }),
    evidenceUq: uniqueIndex("practice_conversion_milestones_evidence_uq").on(
      table.evidenceSource,
      table.evidenceKey,
      table.milestone,
    ),
    milestoneTimeIdx: index(
      "practice_conversion_milestones_stage_time_idx",
    ).on(table.milestone, table.occurredAt, table.practiceId),
    paymentShapeCheck: check(
      "practice_conversion_milestones_payment_shape_check",
      sql`(
        ${table.milestone} = 'first_positive_payment'
        and ${table.amountCents} is not null
        and ${table.amountCents} > 0
        and ${table.currency} is not null
        and ${table.currency} ~ '^[a-z]{3}$'
      ) or (
        ${table.milestone} <> 'first_positive_payment'
        and ${table.amountCents} is null
        and ${table.currency} is null
      )`,
    ),
    evidenceSourceCheck: check(
      "practice_conversion_milestones_evidence_source_check",
      sql`(
        ${table.milestone} = 'registered'
        and ${table.evidenceSource} = 'practice_created'
        and ${table.evidenceKey} like 'practice:%'
      ) or (
        ${table.milestone} = 'activated'
        and ${table.evidenceSource} = 'product_records'
        and ${table.evidenceKey} like 'client:%|appointment:%'
      ) or (
        ${table.milestone} in (
          'payment_method_collected', 'first_positive_payment'
        )
        and ${table.evidenceSource} = 'stripe_webhook'
        and ${table.evidenceKey} like 'stripe:%'
      )`,
    ),
  }),
);
