import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  boolean,
  integer,
  numeric,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";

export const practices = pgTable(
  "practices",
  {
    ...baseColumns(),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address"),
    phone: varchar("phone", { length: 32 }),
    email: varchar("email", { length: 255 }),
    website: varchar("website", { length: 255 }),
    timezone: varchar("timezone", { length: 64 })
      .notNull()
      .default("America/New_York"),
    logoUrl: varchar("logo_url", { length: 512 }),
    settings: jsonb("settings").default({}),
    // Hosted-SaaS subscription (ignored by self-host unless HOSTED_BILLING_ENABLED).
    // subscriptionTier is the canonical plan tier: free | cloud | enterprise.
    subscriptionTier: varchar("subscription_tier", { length: 32 })
      .notNull()
      .default("free"),
    stripeCustomerId: varchar("stripe_customer_id", { length: 64 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 64 }),
    // Stripe-style billing lifecycle: none | trialing | active | past_due | canceled.
    billingStatus: varchar("billing_status", { length: 24 })
      .notNull()
      .default("none"),
    // Monotonic fence for subscription identity/status transitions. Durable
    // billing-email jobs capture this value and refuse delivery after a newer
    // subscription generation supersedes the event that created them.
    subscriptionGeneration: integer("subscription_generation")
      .notNull()
      .default(0),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    // Region/locale — gates currency, tax, formatting, and (later) regulatory
    // behavior. Defaults keep existing US practices working unchanged.
    country: varchar("country", { length: 2 }).notNull().default("US"), // ISO 3166-1 alpha-2
    currency: varchar("currency", { length: 3 }).notNull().default("usd"), // ISO 4217, Stripe-style lowercase
    taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 })
      .notNull()
      .default("8.00"),
    vatNumber: varchar("vat_number", { length: 32 }), // shown on invoices where applicable
    // Automated appointment reminders are deliberately clinic-controlled.
    // New and existing clinics remain off until an admin explicitly enables
    // them after reviewing contact preferences and messaging setup.
    appointmentRemindersEnabled: boolean("appointment_reminders_enabled")
      .notNull()
      .default(false),
    appointmentReminderLeadHours: integer("appointment_reminder_lead_hours")
      .notNull()
      .default(24),
    // Disaster-recovery safety boundary. A restore sets this in the same
    // transaction as the recovered rows so autonomous jobs and external
    // delivery remain quiesced until an owner completes reconciliation.
    recoveryHold: boolean("recovery_hold").notNull().default(false),
    recoveryHoldReason: varchar("recovery_hold_reason", { length: 255 }),
    recoveryHoldSetAt: timestamp("recovery_hold_set_at", {
      withTimezone: true,
    }),
    recoveryHoldReleasedAt: timestamp("recovery_hold_released_at", {
      withTimezone: true,
    }),
    // Capability token for the read-only ICS schedule feed (null = feed off).
    // Practice-wide by design: one shared clinic calendar, same trust
    // boundary as the whiteboard. Rotating it invalidates the old URL.
    calendarFeedToken: varchar("calendar_feed_token", { length: 64 }),
  },
  (table) => ({
    billingTrialIdx: index("practices_billing_trial_idx").on(
      table.billingStatus,
      table.trialEndsAt,
      table.deletedAt,
    ),
    stripeCustomerIdx: index("practices_stripe_customer_idx").on(
      table.stripeCustomerId,
      table.deletedAt,
    ),
    stripeSubscriptionIdx: index("practices_stripe_subscription_idx").on(
      table.stripeSubscriptionId,
      table.deletedAt,
    ),
    // Unique token lookup for the unauthenticated ICS feed route. Postgres
    // treats NULLs as distinct, so practices without a feed are unaffected.
    calendarFeedTokenUq: uniqueIndex("practices_calendar_feed_token_uq").on(
      table.calendarFeedToken,
    ),
    appointmentReminderLeadHoursCheck: check(
      "practices_appointment_reminder_lead_hours_check",
      sql`${table.appointmentReminderLeadHours} in (24, 48, 72)`,
    ),
    recoveryHoldEvidenceCheck: check(
      "practices_recovery_hold_evidence_check",
      sql`not ${table.recoveryHold} or (${table.recoveryHoldSetAt} is not null and ${table.recoveryHoldReason} is not null and ${table.recoveryHoldReason} ~ '[^[:space:]]')`,
    ),
    subscriptionGenerationCheck: check(
      "practices_subscription_generation_check",
      sql`${table.subscriptionGeneration} >= 0`,
    ),
  }),
);

export const locations = pgTable(
  "locations",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address"),
    phone: varchar("phone", { length: 32 }),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (table) => ({
    practiceIdUq: uniqueIndex("locations_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    practiceIdx: index("locations_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    primaryIdx: index("locations_primary_idx").on(
      table.practiceId,
      table.isPrimary,
    ),
  }),
);

export const practicesRelations = relations(practices, ({ many }) => ({
  locations: many(locations),
}));

export const locationsRelations = relations(locations, ({ one }) => ({
  practice: one(practices, {
    fields: [locations.practiceId],
    references: [practices.id],
  }),
}));
