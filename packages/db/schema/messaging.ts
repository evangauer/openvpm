import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices, locations } from "./practices";

// How the location's texting number was obtained.
export const messagingNumberSourceEnum = pgEnum("messaging_number_source", [
  "hosted", // text-enabled the clinic's existing number (no voice port)
  "purchased", // a new local number we bought in-app
  "toll_free", // toll-free fallback
]);

// A2P 10DLC (or toll-free verification) registration lifecycle for the location.
export const messagingRegistrationStatusEnum = pgEnum(
  "messaging_registration_status",
  [
    "not_started",
    "pending", // submitted to the provider / TCR, awaiting approval
    "active", // approved, sending allowed
    "action_required", // provider needs more info from the clinic
    "failed",
    "suspended",
  ]
);

/**
 * Per-location messaging configuration. One row per location (each clinic texts
 * from its own number — see the design doc's number strategy). Holds the sender,
 * the A2P registration state, and the master on/off. Provider-agnostic: `provider`
 * names which adapter (telnyx|twilio) owns this location's sender.
 *
 * This is what resolveSender() reads to pick a location's number instead of the
 * platform-wide env default.
 */
export const locationMessaging = pgTable(
  "location_messaging",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id)
      .unique(),
    provider: varchar("provider", { length: 16 }).notNull().default("telnyx"),
    // Sender: a messaging profile/service id (preferred — number pool + A2P
    // binding) and/or the bare E.164 number.
    messagingProfileId: varchar("messaging_profile_id", { length: 128 }),
    senderE164: varchar("sender_e164", { length: 16 }),
    numberSource: messagingNumberSourceEnum("number_source"),
    // Per-location A2P brand + campaign (registered on the clinic's behalf).
    a2pBrandId: varchar("a2p_brand_id", { length: 128 }),
    a2pCampaignId: varchar("a2p_campaign_id", { length: 128 }),
    registrationStatus: messagingRegistrationStatusEnum("registration_status")
      .notNull()
      .default("not_started"),
    registrationDetail: text("registration_detail"),
    // Master switch — sending is allowed only when enabled AND registration is active.
    enabled: boolean("enabled").notNull().default(false),
  },
  (t) => ({
    practiceIdx: index("location_messaging_practice_idx").on(t.practiceId),
    senderIdx: index("location_messaging_sender_idx").on(t.senderE164),
  })
);

// Why a number is suppressed. STOP is the common, carrier-synced case.
export const smsSuppressionReasonEnum = pgEnum("sms_suppression_reason", [
  "stop", // recipient texted STOP/opt-out (synced from the inbound webhook)
  "manual", // staff added it
  "bounce", // hard delivery failure
  "complaint",
]);

export const emailSuppressionReasonEnum = pgEnum("email_suppression_reason", [
  "manual",
  "bounce",
  "complaint",
  "suppressed",
]);

/**
 * Opt-out / do-not-text list, checked before every send (hard gate in lib/sms.ts).
 * Opt-out is practice-wide per TCPA: once a recipient opts out, suppress across
 * the practice. `locationId` records which number they replied to, for audit.
 */
export const smsSuppressions = pgTable(
  "sms_suppressions",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    locationId: uuid("location_id").references(() => locations.id),
    phone: varchar("phone", { length: 32 }).notNull(), // E.164
    reason: smsSuppressionReasonEnum("reason").notNull().default("stop"),
    detail: text("detail"),
  },
  (t) => ({
    // Idempotent practice-wide suppression + fast "is this number blocked?" lookup.
    practicePhoneUq: uniqueIndex("sms_suppressions_practice_phone_uq").on(
      t.practiceId,
      t.phone
    ),
    practiceIdx: index("sms_suppressions_practice_idx").on(
      t.practiceId,
      t.deletedAt
    ),
  })
);

/**
 * Do-not-email list populated by provider bounce/complaint webhooks and future
 * manual suppressions. Checked before client email sends so OpenVPM fails closed
 * instead of repeatedly mailing bad or complained addresses.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    email: varchar("email", { length: 255 }).notNull(),
    reason: emailSuppressionReasonEnum("reason").notNull().default("bounce"),
    detail: text("detail"),
  },
  (t) => ({
    practiceEmailUq: uniqueIndex("email_suppressions_practice_email_uq").on(
      t.practiceId,
      t.email
    ),
    practiceIdx: index("email_suppressions_practice_idx").on(
      t.practiceId,
      t.deletedAt
    ),
  })
);

export const locationMessagingRelations = relations(
  locationMessaging,
  ({ one }) => ({
    practice: one(practices, {
      fields: [locationMessaging.practiceId],
      references: [practices.id],
    }),
    location: one(locations, {
      fields: [locationMessaging.locationId],
      references: [locations.id],
    }),
  })
);

export const smsSuppressionsRelations = relations(smsSuppressions, ({ one }) => ({
  practice: one(practices, {
    fields: [smsSuppressions.practiceId],
    references: [practices.id],
  }),
}));

export const emailSuppressionsRelations = relations(
  emailSuppressions,
  ({ one }) => ({
    practice: one(practices, {
      fields: [emailSuppressions.practiceId],
      references: [practices.id],
    }),
  })
);
