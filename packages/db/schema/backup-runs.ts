import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const backupRunStatusEnum = pgEnum("backup_run_status", [
  "ok",
  "degraded",
  "failed",
]);

/**
 * Dormant, aggregate-only compatibility storage for database backup evidence.
 *
 * This schema declaration deliberately activates no scheduler or backup job.
 * Rows contain no clinic identity, patient data, object key, provider
 * credential, or provider error text. The migration and RLS baseline restrict
 * access to explicit system context.
 */
export const backupRuns = pgTable(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    runDateUtc: date("run_date_utc").notNull(),
    status: backupRunStatusEnum("status").notNull(),
    practices: integer("practices").notNull(),
    primaryVerified: integer("primary_verified").notNull(),
    primaryFailed: integer("primary_failed").notNull(),
    oversized: integer("oversized").notNull(),
    nearLimit: integer("near_limit").notNull(),
    maxExportBytes: integer("max_export_bytes").notNull(),
    replicaEnabled: boolean("replica_enabled").notNull(),
    replicaRequired: boolean("replica_required").notNull(),
    replicaVerified: integer("replica_verified").notNull(),
    replicaFailed: integer("replica_failed").notNull(),
  },
  (table) => ({
    completedIdx: index("backup_runs_completed_idx").on(
      table.completedAt,
      table.id,
    ),
    completedAfterStartedCheck: check(
      "backup_runs_completed_after_started_check",
      sql`${table.completedAt} >= ${table.startedAt}`,
    ),
    nonnegativeCountsCheck: check(
      "backup_runs_nonnegative_counts_check",
      sql`${table.practices} >= 0
        and ${table.primaryVerified} >= 0
        and ${table.primaryFailed} >= 0
        and ${table.oversized} >= 0
        and ${table.nearLimit} >= 0
        and ${table.maxExportBytes} >= 0
        and ${table.replicaVerified} >= 0
        and ${table.replicaFailed} >= 0`,
    ),
    primaryTotalsCheck: check(
      "backup_runs_primary_totals_check",
      sql`${table.primaryVerified} + ${table.primaryFailed} = ${table.practices}`,
    ),
    primaryFailureShapeCheck: check(
      "backup_runs_primary_failure_shape_check",
      sql`(${table.status} = 'ok' and ${table.primaryFailed} = 0 and ${table.replicaFailed} = 0)
        or (${table.status} = 'degraded' and (${table.primaryFailed} > 0 or ${table.replicaFailed} > 0))
        or (${table.status} = 'failed' and ${table.practices} = 0 and ${table.primaryVerified} = 0)`,
    ),
    replicaExecutionCheck: check(
      "backup_runs_replica_execution_check",
      sql`${table.replicaEnabled} or (${table.replicaVerified} = 0 and ${table.replicaFailed} = 0)`,
    ),
  }),
);
