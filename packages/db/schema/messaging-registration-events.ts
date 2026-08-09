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
} from "drizzle-orm/pg-core";
import {
  messagingRegistrations,
  messagingRegistrationStatusEnum,
} from "./messaging";
import { locations, practices } from "./practices";
import { users } from "./users";

export const messagingRegistrationEventTypeEnum = pgEnum(
  "messaging_registration_event_type",
  [
    "details_saved",
    "provider_operation_started",
    "provider_operation_succeeded",
    "provider_operation_failed",
    "provider_state_observed",
    "provider_ids_attached",
    "stale_lock_cleared",
    "provider_profile_enabled",
    "provider_profile_disabled",
    "provider_profile_verified",
  ],
);

export const messagingRegistrationOperationEnum = pgEnum(
  "messaging_registration_operation",
  [
    "registration_details",
    "brand_submission",
    "campaign_submission",
    "number_assignment",
    "registration_reconciliation",
    "provider_id_recovery",
    "submission_lock_recovery",
    "profile_activation",
    "profile_deactivation",
    "profile_verification",
  ],
);

export const messagingRegistrationActorTypeEnum = pgEnum(
  "messaging_registration_actor_type",
  ["clinic_user", "platform_operator", "system"],
);

/**
 * Append-only, PHI-free carrier-registration evidence. The mutable registration
 * row remains the current-state projection; this table records how it changed
 * and which bounded operator action caused a provider mutation.
 *
 * Deliberately absent: tax identifiers, clinic contact/address fields, client or
 * patient identifiers, free-form provider payloads, and provider error bodies.
 */
export const messagingRegistrationEvents = pgTable(
  "messaging_registration_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => messagingRegistrations.id),
    locationId: uuid("location_id").references(() => locations.id),
    eventType: messagingRegistrationEventTypeEnum("event_type").notNull(),
    operation: messagingRegistrationOperationEnum("operation").notNull(),
    statusBefore: messagingRegistrationStatusEnum("status_before"),
    statusAfter: messagingRegistrationStatusEnum("status_after").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    providerBrandId: varchar("provider_brand_id", { length: 128 }),
    providerCampaignId: varchar("provider_campaign_id", { length: 128 }),
    messagingProfileId: varchar("messaging_profile_id", { length: 128 }),
    providerBrandStatus: varchar("provider_brand_status", { length: 64 }),
    providerCampaignStatus: varchar("provider_campaign_status", { length: 64 }),
    actorType: messagingRegistrationActorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorIdentity: varchar("actor_identity", { length: 255 }),
    actorName: varchar("actor_name", { length: 255 }).notNull(),
    operationId: uuid("operation_id").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(),
  },
  (table) => ({
    registrationHistoryIdx: index(
      "messaging_registration_events_registration_history_idx",
    ).on(table.practiceId, table.registrationId, table.createdAt, table.id),
    practiceTimeIdx: index(
      "messaging_registration_events_practice_time_idx",
    ).on(table.practiceId, table.createdAt, table.id),
    operationEventUq: uniqueIndex(
      "messaging_registration_events_operation_event_uq",
    ).on(table.practiceId, table.operationId, table.eventType),
    registrationTenantFk: foreignKey({
      columns: [table.practiceId, table.registrationId],
      foreignColumns: [
        messagingRegistrations.practiceId,
        messagingRegistrations.id,
      ],
      name: "messaging_registration_events_registration_tenant_fk",
    }),
    locationTenantFk: foreignKey({
      columns: [table.practiceId, table.locationId],
      foreignColumns: [locations.practiceId, locations.id],
      name: "messaging_registration_events_location_tenant_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorUserId],
      foreignColumns: [users.practiceId, users.id],
      name: "messaging_registration_events_actor_tenant_fk",
    }),
    shapeCheck: check(
      "messaging_registration_events_shape_check",
      sql`${table.provider} in ('telnyx', 'twilio')
        and ${table.reasonCode} ~ '^[a-z0-9_]{3,64}$'
        and ${table.actorName} = btrim(${table.actorName})
        and length(${table.actorName}) between 1 and 255
        and (
          (${table.actorType} = 'clinic_user'
            and ${table.actorUserId} is not null
            and ${table.actorIdentity} is null)
          or (${table.actorType} = 'platform_operator'
            and ${table.actorUserId} is null
            and length(btrim(coalesce(${table.actorIdentity}, ''))) between 1 and 255)
          or (${table.actorType} = 'system'
            and ${table.actorUserId} is null
            and ${table.actorIdentity} is null)
        )
        and (${table.providerBrandId} is null or (
          ${table.providerBrandId} = btrim(${table.providerBrandId})
          and length(${table.providerBrandId}) between 3 and 128))
        and (${table.providerCampaignId} is null or (
          ${table.providerCampaignId} = btrim(${table.providerCampaignId})
          and length(${table.providerCampaignId}) between 3 and 128))
        and (${table.messagingProfileId} is null or (
          ${table.messagingProfileId} = btrim(${table.messagingProfileId})
          and length(${table.messagingProfileId}) between 3 and 128))
        and (${table.providerBrandStatus} is null
          or length(${table.providerBrandStatus}) between 1 and 64)
        and (${table.providerCampaignStatus} is null
          or length(${table.providerCampaignStatus}) between 1 and 64)
        and (
          (${table.eventType} = 'details_saved'
            and ${table.operation} = 'registration_details')
          or (${table.eventType} in (
              'provider_operation_started',
              'provider_operation_succeeded',
              'provider_operation_failed'
            ) and ${table.operation} in (
              'brand_submission',
              'campaign_submission',
              'number_assignment'
            ))
          or (${table.eventType} = 'provider_state_observed'
            and ${table.operation} in (
              'brand_submission',
              'campaign_submission',
              'registration_reconciliation'
            ))
          or (${table.eventType} = 'provider_ids_attached'
            and ${table.operation} = 'provider_id_recovery')
          or (${table.eventType} = 'stale_lock_cleared'
            and ${table.operation} = 'submission_lock_recovery')
          or (${table.eventType} = 'provider_profile_enabled'
            and ${table.operation} = 'profile_activation'
            and ${table.locationId} is not null
            and ${table.messagingProfileId} is not null)
          or (${table.eventType} = 'provider_profile_disabled'
            and ${table.operation} = 'profile_deactivation'
            and ${table.locationId} is not null
            and ${table.messagingProfileId} is not null)
          or (${table.eventType} = 'provider_profile_verified'
            and ${table.operation} = 'profile_verification'
            and ${table.locationId} is not null
            and ${table.messagingProfileId} is not null)
        )`,
    ),
  }),
);

export const messagingRegistrationEventsRelations = relations(
  messagingRegistrationEvents,
  ({ one }) => ({
    practice: one(practices, {
      fields: [messagingRegistrationEvents.practiceId],
      references: [practices.id],
    }),
    registration: one(messagingRegistrations, {
      fields: [messagingRegistrationEvents.registrationId],
      references: [messagingRegistrations.id],
    }),
    location: one(locations, {
      fields: [messagingRegistrationEvents.locationId],
      references: [locations.id],
    }),
    actor: one(users, {
      fields: [messagingRegistrationEvents.actorUserId],
      references: [users.id],
    }),
  }),
);
