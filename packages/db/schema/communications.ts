import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { users } from "./users";
import { clients } from "./clients";

export const channelEnum = pgEnum("comm_channel", [
  "phone",
  "sms",
  "email",
  "portal",
]);

export const directionEnum = pgEnum("comm_direction", ["inbound", "outbound"]);

export const commStatusEnum = pgEnum("comm_status", [
  "pending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const communications = pgTable(
  "communications",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id").references(() => clients.id),
    channel: channelEnum("channel").notNull(),
    direction: directionEnum("direction").notNull(),
    subject: varchar("subject", { length: 255 }),
    content: text("content"),
    status: commStatusEnum("status").notNull().default("pending"),
    assignedTo: uuid("assigned_to").references(() => users.id),
    readAt: timestamp("read_at", { withTimezone: true }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    // Idempotency key for system-sent lifecycle emails (welcome, receipt,
    // dunning, trial-ending, usage). Null for ordinary client comms — Postgres
    // treats NULLs as distinct, so the unique index only constrains real keys
    // and makes "send exactly once" race-safe under webhook/cron retries.
    dedupeKey: varchar("dedupe_key", { length: 160 }),
  },
  (table) => ({
    tenantIdUq: uniqueIndex("communications_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    practiceListIdx: index("communications_practice_list_idx").on(
      table.practiceId,
      table.deletedAt,
      table.createdAt,
    ),
    clientTimelineIdx: index("communications_client_timeline_idx").on(
      table.practiceId,
      table.clientId,
      table.deletedAt,
      table.createdAt,
    ),
    inboxStatusIdx: index("communications_inbox_status_idx").on(
      table.practiceId,
      table.direction,
      table.status,
      table.deletedAt,
    ),
    assignedIdx: index("communications_assigned_idx").on(
      table.practiceId,
      table.assignedTo,
      table.deletedAt,
    ),
    dedupeKeyIdx: uniqueIndex("communications_dedupe_key_idx").on(
      table.dedupeKey,
    ),
    providerMessageIdx: index("communications_provider_message_idx").on(
      table.practiceId,
      table.providerMessageId,
      table.channel,
      table.direction,
    ),
  }),
);

export const webhooks = pgTable(
  "webhooks",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    url: varchar("url", { length: 512 }).notNull(),
    events: jsonb("events").notNull().default([]),
    secret: varchar("secret", { length: 255 }).notNull(),
    active: boolean("active").notNull().default(true),
  },
  (table) => ({
    practiceActiveIdx: index("webhooks_practice_active_idx").on(
      table.practiceId,
      table.deletedAt,
      table.active,
    ),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    // Non-secret prefix (e.g. "ovpm_AbC123") used as a fast, indexed lookup to
    // narrow candidates before a constant-time bcrypt compare against keyHash.
    keyPrefix: varchar("key_prefix", { length: 16 }),
    keyHash: varchar("key_hash", { length: 255 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    prefixIdx: index("api_keys_prefix_idx").on(table.keyPrefix),
    practiceCreatedIdx: index("api_keys_practice_created_idx").on(
      table.practiceId,
      table.deletedAt,
      table.createdAt,
    ),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id").references(() => practices.id),
    userId: uuid("user_id").references(() => users.id),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: uuid("entity_id"),
    changes: jsonb("changes"),
    ipAddress: varchar("ip_address", { length: 45 }),
  },
  (table) => ({
    practiceIdx: index("audit_log_practice_idx").on(
      table.practiceId,
      table.createdAt,
    ),
    entityIdx: index("audit_log_entity_idx").on(
      table.entityType,
      table.entityId,
    ),
  }),
);

// Relations
export const communicationsRelations = relations(communications, ({ one }) => ({
  practice: one(practices, {
    fields: [communications.practiceId],
    references: [practices.id],
  }),
  client: one(clients, {
    fields: [communications.clientId],
    references: [clients.id],
  }),
  assignedToUser: one(users, {
    fields: [communications.assignedTo],
    references: [users.id],
  }),
}));

export const webhooksRelations = relations(webhooks, ({ one }) => ({
  practice: one(practices, {
    fields: [webhooks.practiceId],
    references: [practices.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  practice: one(practices, {
    fields: [apiKeys.practiceId],
    references: [practices.id],
  }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  practice: one(practices, {
    fields: [auditLog.practiceId],
    references: [practices.id],
  }),
  user: one(users, {
    fields: [auditLog.userId],
    references: [users.id],
  }),
}));
