import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";
import { users } from "./users";

/**
 * System-only dual-control ledger for lost-all-passkeys recovery. No route
 * exposes these rows yet. Raw recovery grants and identity-proof references
 * are never persisted; only domain-separated SHA-256 digests are stored.
 */
export const authRecoveryCases = pgTable(
  "auth_recovery_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    userId: uuid("user_id").notNull(),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references(() => users.id),
    approverUserId: uuid("approver_user_id").references(() => users.id),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id),
    targetSessionVersion: integer("target_session_version").notNull(),
    revokedSessionVersion: integer("revoked_session_version"),
    status: varchar("status", { length: 16 }).notNull(),
    reasonCode: varchar("reason_code", { length: 32 }).notNull(),
    identityProofReferenceHash: varchar("identity_proof_reference_hash", {
      length: 64,
    }).notNull(),
    recoveryGrantHash: varchar("recovery_grant_hash", { length: 64 }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    targetTenantFk: foreignKey({
      columns: [table.practiceId, table.userId],
      foreignColumns: [users.practiceId, users.id],
      name: "auth_recovery_cases_target_tenant_fk",
    }),
    caseTenantUq: unique("auth_recovery_cases_tenant_id_uq").on(
      table.practiceId,
      table.userId,
      table.id,
    ),
    activeTargetUq: uniqueIndex("auth_recovery_cases_active_target_uq")
      .on(table.practiceId, table.userId)
      .where(sql`${table.status} in ('pending', 'approved')`),
    grantHashUq: uniqueIndex("auth_recovery_cases_grant_hash_uq")
      .on(table.recoveryGrantHash)
      .where(sql`${table.recoveryGrantHash} is not null`),
    queueIdx: index("auth_recovery_cases_queue_idx").on(
      table.status,
      table.expiresAt,
      table.requestedAt,
      table.id,
    ),
    targetSessionCheck: check(
      "auth_recovery_cases_target_session_check",
      sql`${table.targetSessionVersion} > 0
        and (${table.revokedSessionVersion} is null
          or ${table.revokedSessionVersion} = ${table.targetSessionVersion} + 1)`,
    ),
    distinctApproverCheck: check(
      "auth_recovery_cases_distinct_approver_check",
      sql`${table.approverUserId} is null
        or ${table.approverUserId} <> ${table.requesterUserId}`,
    ),
    reasonCheck: check(
      "auth_recovery_cases_reason_check",
      sql`${table.reasonCode} = 'lost_all_passkeys'`,
    ),
    proofHashCheck: check(
      "auth_recovery_cases_proof_hash_check",
      sql`${table.identityProofReferenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    grantHashCheck: check(
      "auth_recovery_cases_grant_hash_check",
      sql`${table.recoveryGrantHash} is null
        or ${table.recoveryGrantHash} ~ '^[0-9a-f]{64}$'`,
    ),
    requestTtlCheck: check(
      "auth_recovery_cases_request_ttl_check",
      sql`${table.expiresAt} = ${table.requestedAt} + interval '24 hours'`,
    ),
    stateCheck: check(
      "auth_recovery_cases_state_check",
      sql`(
          ${table.status} = 'pending'
          and ${table.approverUserId} is null
          and ${table.cancelledByUserId} is null
          and ${table.revokedSessionVersion} is null
          and ${table.recoveryGrantHash} is null
          and ${table.approvedAt} is null
          and ${table.grantExpiresAt} is null
          and ${table.consumedAt} is null
          and ${table.cancelledAt} is null
          and ${table.expiredAt} is null
        ) or (
          ${table.status} = 'approved'
          and ${table.approverUserId} is not null
          and ${table.cancelledByUserId} is null
          and ${table.revokedSessionVersion} = ${table.targetSessionVersion} + 1
          and ${table.recoveryGrantHash} is not null
          and ${table.approvedAt} >= ${table.requestedAt}
          and ${table.approvedAt} <= ${table.expiresAt}
          and ${table.grantExpiresAt} = ${table.approvedAt} + interval '15 minutes'
          and ${table.consumedAt} is null
          and ${table.cancelledAt} is null
          and ${table.expiredAt} is null
        ) or (
          ${table.status} = 'consumed'
          and ${table.approverUserId} is not null
          and ${table.cancelledByUserId} is null
          and ${table.revokedSessionVersion} = ${table.targetSessionVersion} + 1
          and ${table.recoveryGrantHash} is not null
          and ${table.approvedAt} >= ${table.requestedAt}
          and ${table.approvedAt} <= ${table.expiresAt}
          and ${table.grantExpiresAt} = ${table.approvedAt} + interval '15 minutes'
          and ${table.consumedAt} >= ${table.approvedAt}
          and ${table.consumedAt} <= ${table.grantExpiresAt}
          and ${table.cancelledAt} is null
          and ${table.expiredAt} is null
        ) or (
          ${table.status} = 'cancelled'
          and ${table.approverUserId} is null
          and ${table.cancelledByUserId} is not null
          and ${table.revokedSessionVersion} is null
          and ${table.recoveryGrantHash} is null
          and ${table.approvedAt} is null
          and ${table.grantExpiresAt} is null
          and ${table.consumedAt} is null
          and ${table.cancelledAt} >= ${table.requestedAt}
          and ${table.cancelledAt} <= ${table.expiresAt}
          and ${table.expiredAt} is null
        ) or (
          ${table.status} = 'expired'
          and ${table.cancelledByUserId} is null
          and ${table.consumedAt} is null
          and ${table.cancelledAt} is null
          and ${table.expiredAt} is not null
          and ((${table.approverUserId} is null
            and ${table.revokedSessionVersion} is null
            and ${table.recoveryGrantHash} is null
            and ${table.approvedAt} is null
            and ${table.grantExpiresAt} is null
            and ${table.expiredAt} >= ${table.expiresAt})
          or (${table.approverUserId} is not null
            and ${table.revokedSessionVersion} = ${table.targetSessionVersion} + 1
            and ${table.recoveryGrantHash} is not null
            and ${table.approvedAt} >= ${table.requestedAt}
            and ${table.approvedAt} <= ${table.expiresAt}
            and ${table.grantExpiresAt} = ${table.approvedAt} + interval '15 minutes'
            and ${table.expiredAt} >= ${table.grantExpiresAt}))
        )`,
    ),
  }),
);

/** Immutable, free-form-text-free evidence for every recovery transition. */
export const authRecoveryEvents = pgTable(
  "auth_recovery_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id").notNull(),
    practiceId: uuid("practice_id").notNull(),
    userId: uuid("user_id").notNull(),
    /** Null only for the database-time `expired` system event. */
    actorUserId: uuid("actor_user_id").references(() => users.id),
    eventType: varchar("event_type", { length: 24 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    caseTenantFk: foreignKey({
      columns: [table.practiceId, table.userId, table.caseId],
      foreignColumns: [
        authRecoveryCases.practiceId,
        authRecoveryCases.userId,
        authRecoveryCases.id,
      ],
      name: "auth_recovery_events_case_tenant_fk",
    }),
    caseEventUq: uniqueIndex("auth_recovery_events_case_event_uq").on(
      table.caseId,
      table.eventType,
    ),
    caseTimelineIdx: index("auth_recovery_events_case_timeline_idx").on(
      table.caseId,
      table.occurredAt,
      table.id,
    ),
    eventTypeCheck: check(
      "auth_recovery_events_type_check",
      sql`${table.eventType} in ('requested', 'approved', 'reenrollment_started', 'grant_consumed', 'cancelled', 'expired')`,
    ),
  }),
);
