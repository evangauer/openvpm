import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
import { communications } from "./communications";
import { practices } from "./practices";

export const lifecycleEmailJobKindEnum = pgEnum("lifecycle_email_job_kind", [
  "subscription_confirmed",
  "subscription_canceled",
]);

export const lifecycleEmailJobStateEnum = pgEnum(
  "lifecycle_email_job_state",
  [
    "pending",
    "retry",
    "delivering",
    "blocked_recovery",
    "delivered",
    "suppressed_stale",
    "failed",
    "outcome_unknown",
  ],
);

export const lifecycleEmailAttemptOutcomeEnum = pgEnum(
  "lifecycle_email_attempt_outcome",
  ["accepted", "definite_failure", "outcome_unknown"],
);

/**
 * System-only transactional outbox for Stripe subscription notices. It stores
 * no recipient address or rendered body: the normalized recipient is bound by
 * a one-way hash and the exact provider request is bound before first send by
 * request_fingerprint_sha256.
 */
export const lifecycleEmailJobs = pgTable(
  "lifecycle_email_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    communicationId: uuid("communication_id").notNull(),
    kind: lifecycleEmailJobKindEnum("kind").notNull(),
    state: lifecycleEmailJobStateEnum("state").notNull().default("pending"),
    dedupeKey: varchar("dedupe_key", { length: 160 }).notNull(),
    providerIdempotencyKey: varchar("provider_idempotency_key", {
      length: 200,
    }).notNull(),
    recipientHashSha256: varchar("recipient_hash_sha256", {
      length: 64,
    }).notNull(),
    practiceName: varchar("practice_name", { length: 255 }).notNull(),
    subscriptionId: varchar("subscription_id", { length: 64 }).notNull(),
    subscriptionGeneration: integer("subscription_generation").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).default(
      sql`clock_timestamp()`,
    ),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    requestFingerprintSha256: varchar("request_fingerprint_sha256", {
      length: 64,
    }),
    providerMessageId: varchar("provider_message_id", { length: 128 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastOutcome: lifecycleEmailAttemptOutcomeEnum("last_outcome"),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastErrorDetail: text("last_error_detail"),
  },
  (table) => ({
    tenantIdUq: uniqueIndex("lifecycle_email_jobs_practice_id_uq").on(
      table.practiceId,
      table.id,
    ),
    communicationUq: uniqueIndex(
      "lifecycle_email_jobs_communication_uq",
    ).on(table.practiceId, table.communicationId),
    dedupeKeyUq: uniqueIndex("lifecycle_email_jobs_dedupe_key_uq").on(
      table.dedupeKey,
    ),
    dueIdx: index("lifecycle_email_jobs_due_idx")
      .on(table.nextAttemptAt, table.createdAt, table.id)
      .where(
        sql`${table.state} in ('pending', 'retry', 'blocked_recovery')`,
      ),
    leaseIdx: index("lifecycle_email_jobs_lease_idx")
      .on(table.leaseExpiresAt, table.createdAt, table.id)
      .where(sql`${table.state} = 'delivering'`),
    communicationTenantFk: foreignKey({
      columns: [table.practiceId, table.communicationId],
      foreignColumns: [communications.practiceId, communications.id],
      name: "lifecycle_email_jobs_communication_tenant_fk",
    }),
    identityCheck: check(
      "lifecycle_email_jobs_identity_check",
      sql`length(btrim(${table.dedupeKey})) between 1 and 160
        and length(btrim(${table.providerIdempotencyKey})) between 1 and 200
        and ${table.recipientHashSha256} ~ '^[0-9a-f]{64}$'
        and length(btrim(${table.practiceName})) between 1 and 255
        and length(btrim(${table.subscriptionId})) between 1 and 64
        and ${table.subscriptionGeneration} >= 0
        and (${table.requestFingerprintSha256} is null or ${table.requestFingerprintSha256} ~ '^[0-9a-f]{64}$')
        and (${table.lastErrorCode} is null or (
          length(btrim(${table.lastErrorCode})) between 1 and 64
          and ${table.lastErrorCode} ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and (${table.lastErrorDetail} is null or length(${table.lastErrorDetail}) <= 2000)`,
    ),
    stateCheck: check(
      "lifecycle_email_jobs_state_check",
      sql`${table.attemptCount} >= 0 and (
        (
          ${table.state} in ('pending', 'blocked_recovery')
          and ${table.nextAttemptAt} is not null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.completedAt} is null
          and ${table.providerMessageId} is null
        ) or (
          ${table.state} = 'retry'
          and ${table.attemptCount} >= 1
          and ${table.nextAttemptAt} is not null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.completedAt} is null
          and ${table.providerMessageId} is null
          and ${table.lastOutcome} in ('definite_failure', 'outcome_unknown')
        ) or (
          ${table.state} = 'delivering'
          and ${table.nextAttemptAt} is null
          and ${table.leaseToken} is not null
          and ${table.leaseExpiresAt} is not null
          and ${table.completedAt} is null
          and ${table.providerMessageId} is null
        ) or (
          ${table.state} = 'delivered'
          and ${table.nextAttemptAt} is null
          and ${table.completedAt} is not null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.providerMessageId} is not null
          and ${table.lastOutcome} = 'accepted'
        ) or (
          ${table.state} = 'suppressed_stale'
          and ${table.nextAttemptAt} is null
          and ${table.completedAt} is not null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.providerMessageId} is null
        ) or (
          ${table.state} = 'failed'
          and ${table.nextAttemptAt} is null
          and ${table.completedAt} is not null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.providerMessageId} is null
          and ${table.lastOutcome} = 'definite_failure'
        ) or (
          ${table.state} = 'outcome_unknown'
          and ${table.nextAttemptAt} is null
          and ${table.completedAt} is not null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.providerMessageId} is null
          and ${table.lastOutcome} = 'outcome_unknown'
        )
      )`,
    ),
  }),
);

/** One row per provider call. An unresolved row is durable crash-window proof. */
export const lifecycleEmailAttempts = pgTable(
  "lifecycle_email_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    jobId: uuid("job_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    requestFingerprintSha256: varchar("request_fingerprint_sha256", {
      length: 64,
    }).notNull(),
    outcome: lifecycleEmailAttemptOutcomeEnum("outcome"),
    providerMessageId: varchar("provider_message_id", { length: 128 }),
    failureCode: varchar("failure_code", { length: 64 }),
    failureDetail: text("failure_detail"),
  },
  (table) => ({
    jobAttemptUq: uniqueIndex("lifecycle_email_attempts_job_attempt_uq").on(
      table.jobId,
      table.attemptNumber,
    ),
    jobHistoryIdx: index("lifecycle_email_attempts_job_history_idx").on(
      table.practiceId,
      table.jobId,
      table.attemptNumber,
    ),
    providerMessageUq: uniqueIndex(
      "lifecycle_email_attempts_provider_message_uq",
    )
      .on(table.provider, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    jobTenantFk: foreignKey({
      columns: [table.practiceId, table.jobId],
      foreignColumns: [lifecycleEmailJobs.practiceId, lifecycleEmailJobs.id],
      name: "lifecycle_email_attempts_job_tenant_fk",
    }),
    identityCheck: check(
      "lifecycle_email_attempts_identity_check",
      sql`${table.attemptNumber} >= 1
        and ${table.provider} in ('resend', 'console')
        and ${table.requestFingerprintSha256} ~ '^[0-9a-f]{64}$'
        and (${table.failureCode} is null or (
          length(btrim(${table.failureCode})) between 1 and 64
          and ${table.failureCode} ~ '^[A-Za-z0-9_.:-]+$'
        ))
        and (${table.failureDetail} is null or length(${table.failureDetail}) <= 2000)`,
    ),
    outcomeCheck: check(
      "lifecycle_email_attempts_outcome_check",
      sql`(
          ${table.resolvedAt} is null
          and ${table.outcome} is null
          and ${table.providerMessageId} is null
          and ${table.failureCode} is null
          and ${table.failureDetail} is null
        ) or (
          ${table.resolvedAt} is not null
          and ${table.outcome} = 'accepted'
          and ${table.providerMessageId} is not null
          and ${table.failureCode} is null
          and ${table.failureDetail} is null
        ) or (
          ${table.resolvedAt} is not null
          and ${table.outcome} in ('definite_failure', 'outcome_unknown')
          and ${table.providerMessageId} is null
          and ${table.failureCode} is not null
        )`,
    ),
  }),
);

export const lifecycleEmailJobRelations = relations(
  lifecycleEmailJobs,
  ({ one, many }) => ({
    practice: one(practices, {
      fields: [lifecycleEmailJobs.practiceId],
      references: [practices.id],
    }),
    communication: one(communications, {
      fields: [lifecycleEmailJobs.communicationId],
      references: [communications.id],
    }),
    attempts: many(lifecycleEmailAttempts),
  }),
);

export const lifecycleEmailAttemptRelations = relations(
  lifecycleEmailAttempts,
  ({ one }) => ({
    job: one(lifecycleEmailJobs, {
      fields: [lifecycleEmailAttempts.jobId],
      references: [lifecycleEmailJobs.id],
    }),
  }),
);
