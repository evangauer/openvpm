import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from "drizzle-orm/pg-core";
import { clients } from "./clients";
import { locations, practices } from "./practices";
import { users } from "./users";

export const smsConsentActionEnum = pgEnum("sms_consent_action", [
  "granted",
  "revoked",
]);

export const smsConsentActorTypeEnum = pgEnum("sms_consent_actor_type", [
  "staff",
  "client",
  "system",
]);

/**
 * Immutable evidence for every SMS consent grant and revocation. The clients
 * row remains the fast current-state projection; this table preserves what
 * happened, for which normalized destination, under which disclosure, and who
 * initiated it. `eventKey` makes provider webhook replay and migration backfill
 * idempotent without conflating distinct staff decisions.
 */
export const smsConsentEvents = pgTable(
  "sms_consent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    clientId: uuid("client_id").references(() => clients.id),
    locationId: uuid("location_id").references(() => locations.id),
    destinationE164: varchar("destination_e164", { length: 16 }).notNull(),
    action: smsConsentActionEnum("action").notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    disclosureVersion: varchar("disclosure_version", { length: 32 }),
    disclosure: text("disclosure"),
    detail: text("detail"),
    actorType: smsConsentActorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorName: varchar("actor_name", { length: 255 }),
    provider: varchar("provider", { length: 16 }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    eventKey: varchar("event_key", { length: 200 }).notNull(),
  },
  (table) => ({
    eventKeyUq: uniqueIndex("sms_consent_events_practice_event_key_uq").on(
      table.practiceId,
      table.eventKey,
    ),
    clientHistoryIdx: index("sms_consent_events_client_history_idx").on(
      table.practiceId,
      table.clientId,
      table.occurredAt,
      table.id,
    ),
    destinationHistoryIdx: index(
      "sms_consent_events_destination_history_idx",
    ).on(table.practiceId, table.destinationE164, table.occurredAt, table.id),
    providerMessageUq: uniqueIndex("sms_consent_events_provider_message_uq")
      .on(table.practiceId, table.provider, table.providerMessageId)
      .where(
        sql`${table.provider} is not null and ${table.providerMessageId} is not null`,
      ),
    clientTenantFk: foreignKey({
      columns: [table.practiceId, table.clientId],
      foreignColumns: [clients.practiceId, clients.id],
      name: "sms_consent_events_client_tenant_fk",
    }),
    locationTenantFk: foreignKey({
      columns: [table.practiceId, table.locationId],
      foreignColumns: [locations.practiceId, locations.id],
      name: "sms_consent_events_location_tenant_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorUserId],
      foreignColumns: [users.practiceId, users.id],
      name: "sms_consent_events_actor_tenant_fk",
    }),
    destinationCheck: check(
      "sms_consent_events_destination_check",
      sql`${table.destinationE164} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    sourceCheck: check(
      "sms_consent_events_source_check",
      sql`length(btrim(${table.source})) between 1 and 64`,
    ),
    eventKeyCheck: check(
      "sms_consent_events_event_key_check",
      sql`length(btrim(${table.eventKey})) between 1 and 200`,
    ),
    detailCheck: check(
      "sms_consent_events_detail_check",
      sql`${table.detail} is null or length(${table.detail}) <= 2000`,
    ),
    evidenceShapeCheck: check(
      "sms_consent_events_evidence_shape_check",
      sql`(
          ${table.action} = 'granted'
          and length(btrim(coalesce(${table.disclosureVersion}, ''))) > 0
          and length(btrim(coalesce(${table.disclosure}, ''))) > 0
        ) or (
          ${table.action} = 'revoked'
          and ${table.disclosureVersion} is null
          and ${table.disclosure} is null
        )`,
    ),
    actorShapeCheck: check(
      "sms_consent_events_actor_shape_check",
      sql`(
          ${table.actorType} = 'staff'
          and ${table.actorUserId} is not null
          and length(btrim(coalesce(${table.actorName}, ''))) > 0
          and ${table.provider} is null
          and ${table.providerMessageId} is null
        ) or (
          ${table.actorType} = 'client'
          and ${table.actorUserId} is null
          and ${table.actorName} is null
          and ${table.provider} in ('telnyx', 'twilio')
          and length(btrim(coalesce(${table.providerMessageId}, ''))) > 0
        ) or (
          ${table.actorType} = 'system'
          and ${table.actorUserId} is null
          and ${table.actorName} is null
          and ${table.provider} is null
          and ${table.providerMessageId} is null
        )`,
    ),
  }),
);

export const smsConsentEventsRelations = relations(
  smsConsentEvents,
  ({ one }) => ({
    practice: one(practices, {
      fields: [smsConsentEvents.practiceId],
      references: [practices.id],
    }),
    client: one(clients, {
      fields: [smsConsentEvents.clientId],
      references: [clients.id],
    }),
    location: one(locations, {
      fields: [smsConsentEvents.locationId],
      references: [locations.id],
    }),
    actor: one(users, {
      fields: [smsConsentEvents.actorUserId],
      references: [users.id],
    }),
  }),
);
