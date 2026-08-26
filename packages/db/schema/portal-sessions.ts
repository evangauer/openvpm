import {
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { clients } from "./clients";
import { practices } from "./practices";

/**
 * Revocable client-portal browser sessions. The browser receives a random
 * 256-bit credential in an HttpOnly cookie; only its SHA-256 digest is stored.
 */
export const portalSessions = pgTable(
  "portal_sessions",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: varchar("revoked_reason", { length: 48 }),
    createdIpHash: varchar("created_ip_hash", { length: 64 }),
    userAgentHash: varchar("user_agent_hash", { length: 64 }),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("portal_sessions_token_hash_uq").on(
      table.tokenHash,
    ),
    clientActiveIdx: index("portal_sessions_client_active_idx").on(
      table.practiceId,
      table.clientId,
      table.revokedAt,
      table.expiresAt,
    ),
    expiryIdx: index("portal_sessions_expiry_idx").on(table.expiresAt),
    clientTenantFk: foreignKey({
      columns: [table.practiceId, table.clientId],
      foreignColumns: [clients.practiceId, clients.id],
      name: "portal_sessions_client_tenant_fk",
    }),
  }),
);

export const portalSessionsRelations = relations(portalSessions, ({ one }) => ({
  practice: one(practices, {
    fields: [portalSessions.practiceId],
    references: [practices.id],
  }),
  client: one(clients, {
    fields: [portalSessions.clientId],
    references: [clients.id],
  }),
}));
