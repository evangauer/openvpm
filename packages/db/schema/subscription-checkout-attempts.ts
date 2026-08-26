import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";

export const subscriptionCheckoutAttemptStateEnum = pgEnum(
  "subscription_checkout_attempt_state",
  [
    "reserved",
    "creating",
    "outcome_unknown",
    "manual_review",
    "open",
    "completed",
    "expired",
    "failed",
  ],
);

/**
 * Durable, bounded Stripe Checkout request snapshots. A partial unique index
 * permits at most one attempt that could still own an open provider Session
 * for a practice. Provider payloads are never stored; only the typed request,
 * bounded response identity, and reconciliation timestamps are retained.
 */
export const subscriptionCheckoutAttempts = pgTable(
  "subscription_checkout_attempts",
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
    state: subscriptionCheckoutAttemptStateEnum("state")
      .notNull()
      .default("reserved"),
    source: varchar("source", { length: 16 }).notNull(),
    billingCadence: varchar("billing_cadence", { length: 8 }).notNull(),
    returnTarget: varchar("return_target", { length: 16 }).notNull(),
    locationPriceId: varchar("location_price_id", { length: 255 }).notNull(),
    locationQuantity: integer("location_quantity").notNull(),
    customerId: varchar("customer_id", { length: 64 }),
    customerEmail: varchar("customer_email", { length: 255 }),
    customerIdentitySource: varchar("customer_identity_source", {
      length: 24,
    }).notNull(),
    customerIdentityUserId: uuid("customer_identity_user_id"),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    trialPeriodDays: integer("trial_period_days"),
    successUrl: text("success_url").notNull(),
    cancelUrl: text("cancel_url").notNull(),
    providerIdempotencyKey: varchar("provider_idempotency_key", {
      length: 200,
    }).notNull(),
    requestFingerprintSha256: varchar("request_fingerprint_sha256", {
      length: 64,
    }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    firstProviderAttemptAt: timestamp("first_provider_attempt_at", {
      withTimezone: true,
    }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    providerSessionId: varchar("provider_session_id", { length: 255 }),
    providerExpiresAt: timestamp("provider_expires_at", {
      withTimezone: true,
    }),
    lastReconciledAt: timestamp("last_reconciled_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
  },
  (table) => ({
    tenantIdUq: uniqueIndex("subscription_checkout_attempts_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    providerIdempotencyUq: uniqueIndex(
      "subscription_checkout_attempts_provider_idempotency_uq",
    ).on(table.providerIdempotencyKey),
    providerSessionUq: uniqueIndex(
      "subscription_checkout_attempts_provider_session_uq",
    )
      .on(table.providerSessionId)
      .where(sql`${table.providerSessionId} is not null`),
    onePotentiallyOpenUq: uniqueIndex(
      "subscription_checkout_attempts_one_active_uq",
    )
      .on(table.practiceId)
      .where(
        sql`${table.state} in ('reserved', 'creating', 'outcome_unknown', 'manual_review', 'open')`,
      ),
    historyIdx: index("subscription_checkout_attempts_history_idx").on(
      table.practiceId,
      table.createdAt,
      table.id,
    ),
    customerIdentityUserIdx: index(
      "subscription_checkout_attempts_customer_identity_user_idx",
    ).on(table.practiceId, table.customerIdentityUserId),
    identityCheck: check(
      "subscription_checkout_attempts_identity_check",
      sql`${table.source} in ('signup', 'settings')
        and ${table.billingCadence} in ('month', 'year')
        and (
          (${table.source} = 'signup' and ${table.returnTarget} = 'login')
          or (${table.source} = 'settings' and ${table.returnTarget} in ('settings', 'setup'))
        )
        and length(btrim(${table.locationPriceId})) between 1 and 255
        and ${table.locationQuantity} >= 1
        and ${table.customerIdentitySource} in ('stripe_customer', 'practice_email', 'user_email')
        and (
          (${table.customerIdentitySource} = 'stripe_customer'
            and ${table.customerId} is not null and ${table.customerEmail} is null
            and ${table.customerIdentityUserId} is null)
          or (${table.customerIdentitySource} = 'practice_email'
            and ${table.customerId} is null and ${table.customerEmail} is not null
            and ${table.customerIdentityUserId} is null)
          or (${table.customerIdentitySource} = 'user_email'
            and ${table.customerId} is null and ${table.customerEmail} is not null
            and ${table.customerIdentityUserId} is not null)
        )
        and (${table.customerId} is null or length(btrim(${table.customerId})) between 1 and 64)
        and (${table.customerEmail} is null or (
          length(btrim(${table.customerEmail})) between 3 and 255
          and ${table.customerEmail} = lower(btrim(${table.customerEmail}))
        ))
        and num_nonnulls(${table.trialEnd}, ${table.trialPeriodDays}) <= 1
        and (${table.trialPeriodDays} is null or ${table.trialPeriodDays} >= 1)
        and length(${table.successUrl}) between 1 and 2048
        and length(${table.cancelUrl}) between 1 and 2048
        and length(btrim(${table.providerIdempotencyKey})) between 1 and 200
        and ${table.requestFingerprintSha256} ~ '^[0-9a-f]{64}$'
        and (${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[A-Za-z0-9_.:-]{1,64}$')`,
    ),
    stateCheck: check(
      "subscription_checkout_attempts_state_check",
      sql`${table.attemptCount} >= 0 and (
        (${table.state} = 'reserved'
          and ${table.attemptCount} = 0
          and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null
          and ${table.lastAttemptAt} is null and ${table.providerSessionId} is null
          and ${table.firstProviderAttemptAt} is null and ${table.providerExpiresAt} is null
          and ${table.completedAt} is null and ${table.expiredAt} is null
          and ${table.failedAt} is null and ${table.lastErrorCode} is null)
        or (${table.state} = 'creating'
          and ${table.attemptCount} >= 1
          and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null
          and ${table.firstProviderAttemptAt} is not null and ${table.lastAttemptAt} is not null
          and ${table.providerSessionId} is null and ${table.providerExpiresAt} is null
          and ${table.completedAt} is null and ${table.expiredAt} is null
          and ${table.failedAt} is null and ${table.lastErrorCode} is null)
        or (${table.state} = 'outcome_unknown'
          and ${table.attemptCount} >= 1
          and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null
          and ${table.firstProviderAttemptAt} is not null and ${table.lastAttemptAt} is not null
          and ${table.providerSessionId} is null and ${table.providerExpiresAt} is null
          and ${table.completedAt} is null and ${table.expiredAt} is null
          and ${table.failedAt} is null and ${table.lastErrorCode} is not null)
        or (${table.state} = 'manual_review'
          and ${table.attemptCount} >= 1
          and ${table.firstProviderAttemptAt} is not null and ${table.lastAttemptAt} is not null
          and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null
          and num_nonnulls(${table.providerSessionId}, ${table.providerExpiresAt}) in (0, 2)
          and ${table.completedAt} is null and ${table.expiredAt} is null
          and ${table.failedAt} is null and ${table.lastErrorCode} is not null)
        or (${table.state} = 'open'
          and ${table.attemptCount} >= 1
          and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null
          and ${table.firstProviderAttemptAt} is not null and ${table.lastAttemptAt} is not null
          and ${table.providerSessionId} is not null and ${table.providerExpiresAt} is not null
          and ${table.lastReconciledAt} is not null
          and ${table.completedAt} is null and ${table.expiredAt} is null
          and ${table.failedAt} is null)
        or (${table.state} = 'completed'
          and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null
          and ${table.providerSessionId} is not null
          and ${table.completedAt} is not null and ${table.expiredAt} is null
          and ${table.failedAt} is null)
        or (${table.state} = 'expired'
          and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null
          and ${table.expiredAt} is not null
          and ${table.completedAt} is null and ${table.failedAt} is null)
        or (${table.state} = 'failed'
          and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null
          and ${table.providerSessionId} is null
          and ${table.completedAt} is null and ${table.expiredAt} is null
          and ${table.failedAt} is not null and ${table.lastErrorCode} is not null)
      )`,
    ),
  }),
);
