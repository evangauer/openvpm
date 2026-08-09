import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  index,
  uniqueIndex,
  integer,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices, locations } from "./practices";
import { users } from "./users";

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
  ],
);

export const messagingBusinessEntityTypeEnum = pgEnum(
  "messaging_business_entity_type",
  ["PRIVATE_PROFIT", "NON_PROFIT"],
);

/**
 * Practice-level A2P registration. A legal entity registers one carrier brand
 * and campaign, then each location number is assigned to that campaign.
 *
 * Tax IDs are encrypted by the application before persistence. Only the last
 * four digits are retained separately for operator confirmation; neither value
 * is returned through tenant-facing status queries.
 */
export const messagingRegistrations = pgTable(
  "messaging_registrations",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    provider: varchar("provider", { length: 16 }).notNull().default("telnyx"),
    entityType: messagingBusinessEntityTypeEnum("entity_type").notNull(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    legalName: varchar("legal_name", { length: 100 }).notNull(),
    taxIdEncrypted: text("tax_id_encrypted").notNull(),
    taxIdLast4: varchar("tax_id_last4", { length: 4 }).notNull(),
    contactFirstName: varchar("contact_first_name", { length: 100 }).notNull(),
    contactLastName: varchar("contact_last_name", { length: 100 }).notNull(),
    contactEmail: varchar("contact_email", { length: 100 }).notNull(),
    businessPhone: varchar("business_phone", { length: 20 }).notNull(),
    street: varchar("street", { length: 100 }).notNull(),
    city: varchar("city", { length: 100 }).notNull(),
    state: varchar("state", { length: 2 }).notNull(),
    postalCode: varchar("postal_code", { length: 10 }).notNull(),
    country: varchar("country", { length: 2 }).notNull().default("US"),
    website: varchar("website", { length: 100 }).notNull(),
    privacyPolicyUrl: varchar("privacy_policy_url", { length: 500 }).notNull(),
    termsUrl: varchar("terms_url", { length: 500 }).notNull(),
    complianceAttestedAt: timestamp("compliance_attested_at", {
      withTimezone: true,
    }).notNull(),
    complianceAttestedBy: uuid("compliance_attested_by")
      .notNull()
      .references(() => users.id),
    campaignUsecase: varchar("campaign_usecase", { length: 50 })
      .notNull()
      .default("MIXED"),
    status: messagingRegistrationStatusEnum("status")
      .notNull()
      .default("not_started"),
    statusDetail: text("status_detail"),
    providerBrandId: varchar("provider_brand_id", { length: 128 }),
    providerBrandStatus: varchar("provider_brand_status", { length: 64 }),
    providerCampaignId: varchar("provider_campaign_id", { length: 128 }),
    providerCampaignStatus: varchar("provider_campaign_status", { length: 64 }),
    submissionLockId: uuid("submission_lock_id"),
    submissionLockAt: timestamp("submission_lock_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastSubmittedAt: timestamp("last_submitted_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => ({
    practiceIdx: uniqueIndex("messaging_registrations_practice_idx").on(
      t.practiceId,
    ),
    statusIdx: index("messaging_registrations_status_idx").on(
      t.status,
      t.updatedAt,
    ),
    attestedByIdx: index("messaging_registrations_attested_by_idx").on(
      t.complianceAttestedBy,
    ),
    taxIdLast4Check: check(
      "messaging_registrations_tax_id_last4_check",
      sql`${t.taxIdLast4} ~ '^[0-9]{4}$'`,
    ),
    usCountryCheck: check(
      "messaging_registrations_us_country_check",
      sql`${t.country} = 'US'`,
    ),
    usStateCheck: check(
      "messaging_registrations_us_state_check",
      sql`${t.state} ~ '^[A-Z]{2}$'`,
    ),
    attemptCountCheck: check(
      "messaging_registrations_attempt_count_check",
      sql`${t.attemptCount} >= 0`,
    ),
  }),
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
    // Short-lived operator attestation that the provider profile, number,
    // webhook, campaign, destination allowlist, and spend cap all read back in
    // the safe launch state. Clinic enablement requires a fresh attestation.
    providerProfileReady: boolean("provider_profile_ready")
      .notNull()
      .default(false),
    providerProfileSyncedAt: timestamp("provider_profile_synced_at", {
      withTimezone: true,
    }),
    // Master switch — sending is allowed only when enabled AND registration is active.
    enabled: boolean("enabled").notNull().default(false),
  },
  (t) => ({
    practiceIdx: index("location_messaging_practice_idx").on(t.practiceId),
    senderIdx: index("location_messaging_sender_idx").on(t.senderE164),
  }),
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
      t.phone,
    ),
    practiceIdx: index("sms_suppressions_practice_idx").on(
      t.practiceId,
      t.deletedAt,
    ),
  }),
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
      t.email,
    ),
    practiceIdx: index("email_suppressions_practice_idx").on(
      t.practiceId,
      t.deletedAt,
    ),
  }),
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
  }),
);

export const messagingRegistrationsRelations = relations(
  messagingRegistrations,
  ({ one }) => ({
    practice: one(practices, {
      fields: [messagingRegistrations.practiceId],
      references: [practices.id],
    }),
  }),
);

export const smsSuppressionsRelations = relations(
  smsSuppressions,
  ({ one }) => ({
    practice: one(practices, {
      fields: [smsSuppressions.practiceId],
      references: [practices.id],
    }),
  }),
);

export const emailSuppressionsRelations = relations(
  emailSuppressions,
  ({ one }) => ({
    practice: one(practices, {
      fields: [emailSuppressions.practiceId],
      references: [practices.id],
    }),
  }),
);
