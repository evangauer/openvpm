import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./common";

const sha256Check = (column: AnyPgColumn) => sql`${column} ~ '^[a-f0-9]{64}$'`;

/**
 * One durable, PII-free record of the key used to derive recipient identities.
 *
 * The application inserts slot 1 on first use and never updates it. A guarded
 * database-owner rotation transaction may replace its current fingerprint and
 * register one previous fingerprint. Comparing the configured ring with this
 * row prevents an accidental key change from making existing opt-outs
 * unreachable/default-enabled.
 */
export const platformEmailIdentity = pgTable(
  "platform_email_identity",
  {
    keySlot: integer("key_slot").primaryKey().default(1),
    identityKeyFingerprint: varchar("identity_key_fingerprint", {
      length: 64,
    }).notNull(),
    previousIdentityKeyFingerprint: varchar(
      "previous_identity_key_fingerprint",
      { length: 64 },
    ),
    rotationStartedAt: timestamp("rotation_started_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    singletonCheck: check(
      "platform_email_identity_singleton_check",
      sql`${table.keySlot} = 1`,
    ),
    fingerprintCheck: check(
      "platform_email_identity_fingerprint_check",
      sha256Check(table.identityKeyFingerprint),
    ),
    previousFingerprintCheck: check(
      "platform_email_identity_previous_fingerprint_check",
      sql`${table.previousIdentityKeyFingerprint} IS NULL OR ${sha256Check(table.previousIdentityKeyFingerprint)}`,
    ),
    distinctFingerprintsCheck: check(
      "platform_email_identity_distinct_fingerprints_check",
      sql`${table.previousIdentityKeyFingerprint} IS NULL OR ${table.previousIdentityKeyFingerprint} <> ${table.identityKeyFingerprint}`,
    ),
    rotationStateCheck: check(
      "platform_email_identity_rotation_state_check",
      sql`(${table.previousIdentityKeyFingerprint} IS NULL) = (${table.rotationStartedAt} IS NULL)`,
    ),
  }),
);

/**
 * PII-free links between the current and immediately previous recipient HMACs.
 *
 * Rows are derived only while the application has the recipient's plaintext
 * address. They let signed legacy unsubscribe targets converge both projections
 * without ever persisting the address or either identity secret.
 */
export const platformEmailIdentityAliases = pgTable(
  "platform_email_identity_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    currentIdentityKeyFingerprint: varchar("current_identity_key_fingerprint", {
      length: 64,
    }).notNull(),
    currentEmailHash: varchar("current_email_hash", { length: 64 }).notNull(),
    previousIdentityKeyFingerprint: varchar(
      "previous_identity_key_fingerprint",
      { length: 64 },
    ).notNull(),
    previousEmailHash: varchar("previous_email_hash", {
      length: 64,
    }).notNull(),
  },
  (table) => ({
    currentIdentityUq: uniqueIndex(
      "platform_email_identity_aliases_current_uq",
    ).on(table.currentIdentityKeyFingerprint, table.currentEmailHash),
    previousIdentityUq: uniqueIndex(
      "platform_email_identity_aliases_previous_uq",
    ).on(table.previousIdentityKeyFingerprint, table.previousEmailHash),
    currentFingerprintCheck: check(
      "platform_email_identity_aliases_current_fingerprint_check",
      sha256Check(table.currentIdentityKeyFingerprint),
    ),
    currentHashCheck: check(
      "platform_email_identity_aliases_current_hash_check",
      sha256Check(table.currentEmailHash),
    ),
    previousFingerprintCheck: check(
      "platform_email_identity_aliases_previous_fingerprint_check",
      sha256Check(table.previousIdentityKeyFingerprint),
    ),
    previousHashCheck: check(
      "platform_email_identity_aliases_previous_hash_check",
      sha256Check(table.previousEmailHash),
    ),
    distinctFingerprintsCheck: check(
      "platform_email_identity_aliases_distinct_fingerprints_check",
      sql`${table.currentIdentityKeyFingerprint} <> ${table.previousIdentityKeyFingerprint}`,
    ),
    distinctHashesCheck: check(
      "platform_email_identity_aliases_distinct_hashes_check",
      sql`${table.currentEmailHash} <> ${table.previousEmailHash}`,
    ),
  }),
);

/**
 * Current global recipient-level choice for optional email sent by OpenVPM.
 *
 * Only keyed hashes are stored. This is deliberately separate from tenant
 * email_suppressions, which governs messages a clinic sends to pet owners.
 */
export const platformEmailPreferences = pgTable(
  "platform_email_preferences",
  {
    ...baseColumns(),
    emailHash: varchar("email_hash", { length: 64 }).notNull(),
    identityKeyFingerprint: varchar("identity_key_fingerprint", {
      length: 64,
    }).notNull(),
    marketingEnabled: boolean("marketing_enabled").notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    reason: varchar("reason", { length: 32 }).notNull(),
    updatedByUserId: uuid("updated_by_user_id"),
  },
  (table) => ({
    emailHashUq: uniqueIndex("platform_email_preferences_email_hash_uq").on(
      table.emailHash,
    ),
    fingerprintIdx: index(
      "platform_email_preferences_identity_fingerprint_idx",
    ).on(table.identityKeyFingerprint),
    emailHashCheck: check(
      "platform_email_preferences_email_hash_check",
      sha256Check(table.emailHash),
    ),
    fingerprintCheck: check(
      "platform_email_preferences_identity_fingerprint_check",
      sha256Check(table.identityKeyFingerprint),
    ),
    sourceCheck: check(
      "platform_email_preferences_source_check",
      sql`${table.source} in ('settings', 'unsubscribe_link', 'resend_webhook')`,
    ),
    reasonCheck: check(
      "platform_email_preferences_reason_check",
      sql`${table.reason} in ('settings_enabled', 'settings_disabled', 'unsubscribe', 'complaint', 'bounce', 'provider_suppressed')`,
    ),
    stateCheck: check(
      "platform_email_preferences_state_check",
      sql`(${table.marketingEnabled} AND ${table.reason} = 'settings_enabled') OR (NOT ${table.marketingEnabled} AND ${table.reason} <> 'settings_enabled')`,
    ),
  }),
);

/**
 * Append-only audit evidence for every platform-email preference action.
 * `applied = false` records idempotent or precedence-blocked actions without
 * allowing them to rewrite the current projection.
 */
export const platformEmailPreferenceEvents = pgTable(
  "platform_email_preference_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    emailHash: varchar("email_hash", { length: 64 }).notNull(),
    identityKeyFingerprint: varchar("identity_key_fingerprint", {
      length: 64,
    }).notNull(),
    requestedMarketingEnabled: boolean("requested_marketing_enabled").notNull(),
    applied: boolean("applied").notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    reason: varchar("reason", { length: 32 }).notNull(),
    updatedByUserId: uuid("updated_by_user_id"),
    providerEventKeyHash: varchar("provider_event_key_hash", { length: 64 }),
  },
  (table) => ({
    recipientTimelineIdx: index(
      "platform_email_preference_events_recipient_timeline_idx",
    ).on(table.emailHash, table.createdAt),
    providerEventKeyUq: uniqueIndex(
      "platform_email_preference_events_provider_event_key_uq",
    ).on(table.providerEventKeyHash),
    emailHashCheck: check(
      "platform_email_preference_events_email_hash_check",
      sha256Check(table.emailHash),
    ),
    fingerprintCheck: check(
      "platform_email_preference_events_identity_fingerprint_check",
      sha256Check(table.identityKeyFingerprint),
    ),
    providerEventKeyHashCheck: check(
      "platform_email_preference_events_provider_event_key_hash_check",
      sql`${table.providerEventKeyHash} IS NULL OR ${sha256Check(table.providerEventKeyHash)}`,
    ),
    sourceCheck: check(
      "platform_email_preference_events_source_check",
      sql`${table.source} in ('settings', 'unsubscribe_link', 'resend_webhook')`,
    ),
    reasonCheck: check(
      "platform_email_preference_events_reason_check",
      sql`${table.reason} in ('settings_enabled', 'settings_disabled', 'unsubscribe', 'complaint', 'bounce', 'provider_suppressed')`,
    ),
    requestStateCheck: check(
      "platform_email_preference_events_request_state_check",
      sql`(${table.requestedMarketingEnabled} AND ${table.reason} = 'settings_enabled') OR (NOT ${table.requestedMarketingEnabled} AND ${table.reason} <> 'settings_enabled')`,
    ),
  }),
);
