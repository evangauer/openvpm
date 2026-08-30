import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";
import { users } from "./users";

/**
 * One-time evidence for a fresh factor confirmation. The browser holds the
 * signed raw nonce; the database stores only its SHA-256 digest. A row can be
 * consumed exactly once for its declared tRPC action and session generation.
 */
export const privilegedActionProofs = pgTable(
  "privileged_action_proofs",
  {
    id: uuid("id").primaryKey(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: uuid("user_id").notNull(),
    sessionVersion: integer("session_version").notNull(),
    action: varchar("action", { length: 96 }).notNull(),
    nonceHash: varchar("nonce_hash", { length: 64 }).notNull(),
    factorType: varchar("factor_type", { length: 16 }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => ({
    userTenantFk: foreignKey({
      columns: [table.practiceId, table.userId],
      foreignColumns: [users.practiceId, users.id],
      name: "privileged_action_proofs_user_tenant_fk",
    }),
    nonceHashUq: uniqueIndex("privileged_action_proofs_nonce_hash_uq").on(
      table.nonceHash,
    ),
    activeIdx: index("privileged_action_proofs_active_idx").on(
      table.practiceId,
      table.userId,
      table.sessionVersion,
      table.action,
      table.consumedAt,
      table.expiresAt,
    ),
    sessionVersionCheck: check(
      "privileged_action_proofs_session_version_check",
      sql`${table.sessionVersion} > 0`,
    ),
    actionShapeCheck: check(
      "privileged_action_proofs_action_shape_check",
      sql`${table.action} ~ '^(admin|billing|subscription|settings|data|apiKeys|webhooks|passkeys)[.][A-Za-z][A-Za-z0-9]+$'`,
    ),
    nonceHashCheck: check(
      "privileged_action_proofs_nonce_hash_check",
      sql`${table.nonceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    factorTypeCheck: check(
      "privileged_action_proofs_factor_type_check",
      sql`${table.factorType} in ('passkey', 'totp', 'recovery')`,
    ),
    ttlCheck: check(
      "privileged_action_proofs_ttl_check",
      sql`${table.expiresAt} = ${table.issuedAt} + interval '5 minutes'`,
    ),
    consumptionTimeCheck: check(
      "privileged_action_proofs_consumption_time_check",
      sql`${table.consumedAt} is null or (${table.consumedAt} >= ${table.issuedAt} and ${table.consumedAt} <= ${table.expiresAt})`,
    ),
  }),
);
