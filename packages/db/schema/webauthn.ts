import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";
import { users } from "./users";
import { authRecoveryCases } from "./auth-recovery";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export type WebAuthnTransport =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

/**
 * Public-key credentials are tenant-bound security identities. Public keys are
 * not secret, but credential identifiers remain pseudonymous account data.
 * Rows are retired rather than deleted so audit evidence remains attributable.
 */
export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: uuid("user_id").notNull(),
    credentialId: varchar("credential_id", { length: 1024 }).notNull(),
    publicKey: bytea("public_key").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull(),
    deviceType: varchar("device_type", { length: 16 }).notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: jsonb("transports").$type<WebAuthnTransport[]>().notNull(),
    aaguid: uuid("aaguid").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    userTenantFk: foreignKey({
      columns: [table.practiceId, table.userId],
      foreignColumns: [users.practiceId, users.id],
      name: "webauthn_credentials_user_tenant_fk",
    }),
    credentialIdUq: uniqueIndex("webauthn_credentials_credential_id_uq").on(
      table.credentialId,
    ),
    activeUserIdx: index("webauthn_credentials_active_user_idx").on(
      table.practiceId,
      table.userId,
      table.deletedAt,
    ),
    credentialIdShapeCheck: check(
      "webauthn_credentials_credential_id_shape_check",
      sql`length(${table.credentialId}) between 16 and 1024
        and ${table.credentialId} ~ '^[A-Za-z0-9_-]+$'`,
    ),
    publicKeySizeCheck: check(
      "webauthn_credentials_public_key_size_check",
      sql`octet_length(${table.publicKey}) between 32 and 4096`,
    ),
    counterCheck: check(
      "webauthn_credentials_counter_check",
      sql`${table.counter} >= 0`,
    ),
    deviceTypeCheck: check(
      "webauthn_credentials_device_type_check",
      sql`${table.deviceType} in ('singleDevice', 'multiDevice')`,
    ),
    transportsCheck: check(
      "webauthn_credentials_transports_check",
      sql`jsonb_typeof(${table.transports}) = 'array'
        and jsonb_array_length(${table.transports}) <= 7
        and ${table.transports} <@ '["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]'::jsonb`,
    ),
    nameCheck: check(
      "webauthn_credentials_name_check",
      sql`length(btrim(${table.name})) between 1 and 80`,
    ),
    useTimeCheck: check(
      "webauthn_credentials_use_time_check",
      sql`${table.lastUsedAt} is null or ${table.lastUsedAt} >= ${table.createdAt}`,
    ),
    deletionTimeCheck: check(
      "webauthn_credentials_deletion_time_check",
      sql`${table.deletedAt} is null or ${table.deletedAt} >= ${table.createdAt}`,
    ),
  }),
);

/**
 * One-time ceremony challenges. Only a domain-separated SHA-256 digest is
 * persisted; the signed plaintext challenge returns from the authenticator.
 */
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: uuid("user_id").notNull(),
    sessionVersion: integer("session_version").notNull(),
    purpose: varchar("purpose", { length: 24 }).notNull(),
    action: varchar("action", { length: 96 }),
    recoveryCaseId: uuid("recovery_case_id"),
    challengeHash: varchar("challenge_hash", { length: 64 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => ({
    userTenantFk: foreignKey({
      columns: [table.practiceId, table.userId],
      foreignColumns: [users.practiceId, users.id],
      name: "webauthn_challenges_user_tenant_fk",
    }),
    recoveryCaseTenantFk: foreignKey({
      columns: [table.practiceId, table.userId, table.recoveryCaseId],
      foreignColumns: [
        authRecoveryCases.practiceId,
        authRecoveryCases.userId,
        authRecoveryCases.id,
      ],
      name: "webauthn_challenges_recovery_case_tenant_fk",
    }),
    challengeHashUq: uniqueIndex("webauthn_challenges_hash_uq").on(
      table.challengeHash,
    ),
    activeUserIdx: index("webauthn_challenges_active_user_idx").on(
      table.practiceId,
      table.userId,
      table.sessionVersion,
      table.purpose,
      table.consumedAt,
      table.expiresAt,
    ),
    sessionVersionCheck: check(
      "webauthn_challenges_session_version_check",
      sql`${table.sessionVersion} > 0`,
    ),
    purposeCheck: check(
      "webauthn_challenges_purpose_check",
      sql`${table.purpose} in ('registration', 'login', 'privileged_action', 'recovery_registration')`,
    ),
    actionShapeCheck: check(
      "webauthn_challenges_action_shape_check",
      sql`(${table.purpose} = 'privileged_action'
          and ${table.action} ~ '^(admin|billing|subscription|settings|data|apiKeys|webhooks|passkeys)[.][A-Za-z][A-Za-z0-9]+$')
        or (${table.purpose} <> 'privileged_action' and ${table.action} is null)`,
    ),
    recoveryCaseShapeCheck: check(
      "webauthn_challenges_recovery_case_shape_check",
      sql`(${table.purpose} = 'recovery_registration'
          and ${table.recoveryCaseId} is not null)
        or (${table.purpose} <> 'recovery_registration'
          and ${table.recoveryCaseId} is null)`,
    ),
    hashCheck: check(
      "webauthn_challenges_hash_check",
      sql`${table.challengeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    ttlCheck: check(
      "webauthn_challenges_ttl_check",
      sql`${table.expiresAt} = ${table.issuedAt} + interval '5 minutes'`,
    ),
    consumptionTimeCheck: check(
      "webauthn_challenges_consumption_time_check",
      sql`${table.consumedAt} is null or (${table.consumedAt} >= ${table.issuedAt} and ${table.consumedAt} <= ${table.expiresAt})`,
    ),
  }),
);
