import {
  check,
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { locations } from "./practices";

export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "veterinarian",
  "technician",
  "front_desk",
  // Read-only access — can view everything in their practice but cannot
  // mutate. Useful for running OpenVPM as a parallel backup/secondary.
  "viewer",
]);

export const users = pgTable(
  "users",
  {
    ...baseColumns(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    /** Increment to revoke every JWT issued for an older identity generation. */
    sessionVersion: integer("session_version").notNull().default(1),
    name: varchar("name", { length: 255 }).notNull(),
    role: userRoleEnum("role").notNull().default("front_desk"),
    // Authorization and clinical identity are intentionally separate. A
    // clinic owner can remain the required administrator while also appearing
    // as a veterinarian provider for scheduling and clinical sign-off.
    isVeterinarian: boolean("is_veterinarian").notNull().default(false),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    locationId: uuid("location_id").references(() => locations.id),
    avatarUrl: varchar("avatar_url", { length: 512 }),
    licenseNumber: varchar("license_number", { length: 64 }),
    phone: varchar("phone", { length: 32 }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    // Dormant compatibility fields only. Authentication does not read or write
    // them until a separately reviewed MFA capability is explicitly enabled.
    mfaSecretEncrypted: text("mfa_secret_encrypted"),
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
    mfaLastUsedTotpCounter: integer("mfa_last_used_totp_counter"),
    mfaRecoveryCodeHashes: jsonb("mfa_recovery_code_hashes"),
    mfaPendingSecretEncrypted: text("mfa_pending_secret_encrypted"),
    mfaPendingExpiresAt: timestamp("mfa_pending_expires_at", {
      withTimezone: true,
    }),
  },
  (table) => ({
    practiceIdUq: uniqueIndex("users_practice_id_uq").on(
      table.practiceId,
      table.id
    ),
    practiceIdx: index("users_practice_idx").on(
      table.practiceId,
      table.deletedAt
    ),
    locationIdx: index("users_location_idx").on(
      table.practiceId,
      table.locationId,
      table.deletedAt
    ),
    roleIdx: index("users_role_idx").on(table.practiceId, table.role),
    veterinarianIdx: index("users_veterinarian_idx").on(
      table.practiceId,
      table.isVeterinarian,
      table.deletedAt
    ),
    mfaActiveShapeCheck: check(
      "users_mfa_active_shape_check",
      sql`(${table.mfaEnabledAt} is null
          and ${table.mfaSecretEncrypted} is null
          and ${table.mfaLastUsedTotpCounter} is null
          and ${table.mfaRecoveryCodeHashes} is null)
        or
        (${table.mfaEnabledAt} is not null
          and length(${table.mfaSecretEncrypted}) between 40 and 1024
          and jsonb_typeof(${table.mfaRecoveryCodeHashes}) = 'array'
          and jsonb_array_length(${table.mfaRecoveryCodeHashes}) <= 20)`,
    ),
    mfaPendingShapeCheck: check(
      "users_mfa_pending_shape_check",
      sql`(${table.mfaPendingSecretEncrypted} is null and ${table.mfaPendingExpiresAt} is null)
        or
        (${table.mfaEnabledAt} is null
          and length(${table.mfaPendingSecretEncrypted}) between 40 and 1024
          and ${table.mfaPendingExpiresAt} is not null)`,
    ),
    mfaTotpCounterCheck: check(
      "users_mfa_totp_counter_check",
      sql`${table.mfaLastUsedTotpCounter} is null or ${table.mfaLastUsedTotpCounter} >= 0`,
    ),
  })
);

export const usersRelations = relations(users, ({ one }) => ({
  practice: one(practices, {
    fields: [users.practiceId],
    references: [practices.id],
  }),
  location: one(locations, {
    fields: [users.locationId],
    references: [locations.id],
  }),
}));
