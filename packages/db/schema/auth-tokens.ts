import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { baseColumns } from "./common";
import { users } from "./users";

/**
 * Single-use, expiring tokens for email verification + password reset. Only the
 * SHA-256 hash of the token is stored (never the raw value). These are
 * pre-tenant / cross-tenant by nature (a user may be locked out), so they are
 * NOT under RLS and are accessed via withSystem.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    ...baseColumns(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    email: varchar("email", { length: 255 }).notNull(),
    /** SHA-256 hex of the raw token. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** "email_verify" | "password_reset" */
    type: varchar("type", { length: 24 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => ({
    tokenHashIdx: index("auth_tokens_hash_idx").on(t.tokenHash),
    expiresIdx: index("auth_tokens_expires_idx").on(t.expiresAt),
  })
);
