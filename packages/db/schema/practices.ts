import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  boolean,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
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
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    // Region/locale — gates currency, tax, formatting, and (later) regulatory
    // behavior. Defaults keep existing US practices working unchanged.
    country: varchar("country", { length: 2 }).notNull().default("US"), // ISO 3166-1 alpha-2
    currency: varchar("currency", { length: 3 }).notNull().default("usd"), // ISO 4217, Stripe-style lowercase
    taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 })
      .notNull()
      .default("8.00"),
    vatNumber: varchar("vat_number", { length: 32 }), // shown on invoices where applicable
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
