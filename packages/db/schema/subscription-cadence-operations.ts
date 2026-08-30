import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";
import { users } from "./users";

export const subscriptionCadenceOperationStateEnum = pgEnum(
  "subscription_cadence_operation_state",
  [
    "reserved",
    "inspecting",
    "authorized",
    "creating_schedule",
    "schedule_created",
    "configuring_schedule",
    "outcome_unknown",
    "scheduled",
    "applied",
    "failed",
    "manual_review",
    "superseded",
  ],
);

/**
 * Durable monthly-to-annual renewal requests. The immutable request snapshot
 * fences a specific local subscription generation and provider identity. The
 * two provider mutation steps are separated by a committed schedule identity,
 * so a crash can only replay stable idempotency keys instead of creating a
 * second schedule. Raw provider payloads are deliberately never retained.
 */
export const subscriptionCadenceOperations = pgTable(
  "subscription_cadence_operations",
  {
    id: uuid("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    requestedBy: uuid("requested_by").notNull(),
    state: subscriptionCadenceOperationStateEnum("state")
      .notNull()
      .default("reserved"),
    revision: integer("revision").notNull().default(0),

    fromCadence: varchar("from_cadence", { length: 8 }).notNull(),
    targetCadence: varchar("target_cadence", { length: 8 }).notNull(),
    stripeCustomerId: varchar("stripe_customer_id", { length: 64 }).notNull(),
    stripeSubscriptionId: varchar("stripe_subscription_id", {
      length: 64,
    }).notNull(),
    subscriptionGeneration: integer("subscription_generation").notNull(),
    subscriptionSyncRevision: integer("subscription_sync_revision").notNull(),
    targetLocationPriceId: varchar("target_location_price_id", {
      length: 255,
    }).notNull(),
    requestedLocationQuantity: integer("requested_location_quantity").notNull(),
    requestFingerprintSha256: varchar("request_fingerprint_sha256", {
      length: 64,
    }).notNull(),
    scheduleCreateIdempotencyKey: varchar("schedule_create_idempotency_key", {
      length: 200,
    }).notNull(),
    scheduleConfigureIdempotencyKey: varchar(
      "schedule_configure_idempotency_key",
      { length: 200 },
    ).notNull(),

    attemptCount: integer("attempt_count").notNull().default(0),
    firstProviderAttemptAt: timestamp("first_provider_attempt_at", {
      withTimezone: true,
    }),
    lastProviderAttemptAt: timestamp("last_provider_attempt_at", {
      withTimezone: true,
    }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),

    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    providerSnapshotFingerprintSha256: varchar(
      "provider_snapshot_fingerprint_sha256",
      { length: 64 },
    ),
    currentLocationItemId: varchar("current_location_item_id", {
      length: 255,
    }),
    currentLocationPriceId: varchar("current_location_price_id", {
      length: 255,
    }),
    currentLocationQuantity: integer("current_location_quantity"),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
    }),
    observedProviderScheduleId: varchar("observed_provider_schedule_id", {
      length: 255,
    }),

    providerScheduleId: varchar("provider_schedule_id", { length: 255 }),
    scheduleCreatedAt: timestamp("schedule_created_at", {
      withTimezone: true,
    }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    manualReviewAt: timestamp("manual_review_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
  },
  (table) => ({
    requesterTenantFk: foreignKey({
      columns: [table.practiceId, table.requestedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "subscription_cadence_operations_requester_tenant_fk",
    }),
    tenantIdUq: uniqueIndex(
      "subscription_cadence_operations_practice_id_uq",
    ).on(table.practiceId, table.id),
    scheduleCreateIdempotencyUq: uniqueIndex(
      "subscription_cadence_operations_create_idempotency_uq",
    ).on(table.scheduleCreateIdempotencyKey),
    scheduleConfigureIdempotencyUq: uniqueIndex(
      "subscription_cadence_operations_configure_idempotency_uq",
    ).on(table.scheduleConfigureIdempotencyKey),
    providerScheduleUq: uniqueIndex(
      "subscription_cadence_operations_provider_schedule_uq",
    )
      .on(table.providerScheduleId)
      .where(sql`${table.providerScheduleId} is not null`),
    oneActiveUq: uniqueIndex("subscription_cadence_operations_one_active_uq")
      .on(table.practiceId)
      .where(
        sql`${table.state} in ('reserved', 'inspecting', 'authorized', 'creating_schedule', 'schedule_created', 'configuring_schedule', 'outcome_unknown', 'scheduled', 'manual_review')`,
      ),
    historyIdx: index("subscription_cadence_operations_history_idx").on(
      table.practiceId,
      table.createdAt,
      table.id,
    ),
    requestIdentityCheck: check(
      "subscription_cadence_operations_request_identity_check",
      sql`${table.fromCadence} = 'month'
        and ${table.targetCadence} = 'year'
        and length(btrim(${table.stripeCustomerId})) between 1 and 64
        and length(btrim(${table.stripeSubscriptionId})) between 1 and 64
        and ${table.subscriptionGeneration} >= 0
        and ${table.subscriptionSyncRevision} >= 0
        and length(btrim(${table.targetLocationPriceId})) between 1 and 255
        and ${table.requestedLocationQuantity} >= 1
        and ${table.requestFingerprintSha256} ~ '^[0-9a-f]{64}$'
        and length(btrim(${table.scheduleCreateIdempotencyKey})) between 1 and 200
        and length(btrim(${table.scheduleConfigureIdempotencyKey})) between 1 and 200
        and ${table.scheduleCreateIdempotencyKey} <> ${table.scheduleConfigureIdempotencyKey}
        and (${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[A-Za-z0-9_.:-]{1,64}$')`,
    ),
    evidenceShapeCheck: check(
      "subscription_cadence_operations_evidence_shape_check",
      sql`${table.revision} >= 0
        and ${table.attemptCount} >= 0
        and ((${table.leaseToken} is null) = (${table.leaseExpiresAt} is null))
        and (
          (${table.authorizedAt} is null
            and ${table.providerSnapshotFingerprintSha256} is null
            and ${table.currentLocationItemId} is null
            and ${table.currentLocationPriceId} is null
            and ${table.currentLocationQuantity} is null
            and ${table.currentPeriodStart} is null
            and ${table.currentPeriodEnd} is null)
          or (${table.authorizedAt} is not null
            and ${table.providerSnapshotFingerprintSha256} is not null
            and ${table.providerSnapshotFingerprintSha256} ~ '^[0-9a-f]{64}$'
            and ${table.currentLocationItemId} is not null
            and length(btrim(${table.currentLocationItemId})) between 1 and 255
            and ${table.currentLocationPriceId} is not null
            and length(btrim(${table.currentLocationPriceId})) between 1 and 255
            and ${table.currentLocationQuantity} is not null
            and ${table.currentLocationQuantity} >= 1
            and ${table.currentPeriodStart} is not null
            and ${table.currentPeriodEnd} > ${table.currentPeriodStart})
        )
        and ((${table.providerScheduleId} is null and ${table.scheduleCreatedAt} is null)
          or (${table.providerScheduleId} is not null
            and length(btrim(${table.providerScheduleId})) between 1 and 255
            and ${table.scheduleCreatedAt} is not null))
        and (${table.observedProviderScheduleId} is null
          or length(btrim(${table.observedProviderScheduleId})) between 1 and 255)
        and ((${table.scheduledAt} is null) = (${table.effectiveAt} is null))
        and (${table.appliedAt} is null or ${table.appliedAt} >= ${table.effectiveAt})
        and (${table.firstProviderAttemptAt} is null
          or (${table.lastProviderAttemptAt} is not null
            and ${table.lastProviderAttemptAt} >= ${table.firstProviderAttemptAt}))`,
    ),
    stateCheck: check(
      "subscription_cadence_operations_state_check",
      sql`(
        (${table.state} = 'reserved'
          and ${table.attemptCount} = 0 and ${table.revision} = 0
          and ${table.firstProviderAttemptAt} is null and ${table.lastProviderAttemptAt} is null
          and ${table.leaseToken} is null and ${table.authorizedAt} is null
          and ${table.providerScheduleId} is null and ${table.scheduledAt} is null
          and ${table.effectiveAt} is null and ${table.appliedAt} is null
          and ${table.failedAt} is null and ${table.manualReviewAt} is null
          and ${table.supersededAt} is null and ${table.lastErrorCode} is null)
        or (${table.state} = 'inspecting'
          and ${table.attemptCount} >= 1 and ${table.firstProviderAttemptAt} is not null
          and ${table.lastProviderAttemptAt} is not null and ${table.leaseToken} is not null
          and ${table.authorizedAt} is null and ${table.providerScheduleId} is null
          and ${table.scheduledAt} is null and ${table.effectiveAt} is null
          and ${table.appliedAt} is null and ${table.failedAt} is null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is null)
        or (${table.state} = 'authorized'
          and ${table.attemptCount} >= 1 and ${table.authorizedAt} is not null
          and ${table.leaseToken} is null and ${table.providerScheduleId} is null
          and ${table.scheduledAt} is null and ${table.effectiveAt} is null
          and ${table.appliedAt} is null and ${table.failedAt} is null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is null)
        or (${table.state} = 'creating_schedule'
          and ${table.attemptCount} >= 2 and ${table.authorizedAt} is not null
          and ${table.leaseToken} is not null and ${table.providerScheduleId} is null
          and ${table.scheduledAt} is null and ${table.effectiveAt} is null
          and ${table.appliedAt} is null and ${table.failedAt} is null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is null)
        or (${table.state} = 'schedule_created'
          and ${table.attemptCount} >= 2 and ${table.authorizedAt} is not null
          and ${table.leaseToken} is null and ${table.providerScheduleId} is not null
          and ${table.scheduledAt} is null and ${table.effectiveAt} is null
          and ${table.appliedAt} is null and ${table.failedAt} is null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is null)
        or (${table.state} = 'configuring_schedule'
          and ${table.attemptCount} >= 3 and ${table.authorizedAt} is not null
          and ${table.leaseToken} is not null and ${table.providerScheduleId} is not null
          and ${table.scheduledAt} is null and ${table.effectiveAt} is null
          and ${table.appliedAt} is null and ${table.failedAt} is null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is null)
        or (${table.state} = 'outcome_unknown'
          and ${table.attemptCount} >= 2 and ${table.authorizedAt} is not null
          and ${table.leaseToken} is null and ${table.scheduledAt} is null
          and ${table.effectiveAt} is null and ${table.appliedAt} is null
          and ${table.failedAt} is null and ${table.manualReviewAt} is null
          and ${table.supersededAt} is null and ${table.lastErrorCode} is not null)
        or (${table.state} = 'scheduled'
          and ${table.attemptCount} >= 3 and ${table.authorizedAt} is not null
          and ${table.leaseToken} is null and ${table.providerScheduleId} is not null
          and ${table.scheduledAt} is not null and ${table.effectiveAt} = ${table.currentPeriodEnd}
          and ${table.appliedAt} is null and ${table.failedAt} is null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is null)
        or (${table.state} = 'applied'
          and ${table.attemptCount} >= 3 and ${table.authorizedAt} is not null
          and ${table.leaseToken} is null and ${table.providerScheduleId} is not null
          and ${table.scheduledAt} is not null and ${table.effectiveAt} = ${table.currentPeriodEnd}
          and ${table.appliedAt} is not null and ${table.failedAt} is null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is null)
        or (${table.state} = 'failed'
          and ${table.attemptCount} >= 1 and ${table.leaseToken} is null
          and ${table.scheduledAt} is null and ${table.effectiveAt} is null
          and ${table.appliedAt} is null and ${table.failedAt} is not null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is not null)
        or (${table.state} = 'manual_review'
          and ${table.attemptCount} >= 1 and ${table.leaseToken} is null
          and ${table.appliedAt} is null and ${table.failedAt} is null
          and ${table.manualReviewAt} is not null and ${table.supersededAt} is null
          and ${table.lastErrorCode} is not null)
        or (${table.state} = 'superseded'
          and ${table.attemptCount} >= 0 and ${table.leaseToken} is null
          and ${table.appliedAt} is null and ${table.failedAt} is null
          and ${table.manualReviewAt} is null and ${table.supersededAt} is not null)
      )`,
    ),
  }),
);
