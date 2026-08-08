import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { users } from "./users";

export const migrationRunModeEnum = pgEnum("migration_run_mode", [
  "clients",
  "patients",
  "vaccinations",
  "soap_notes",
]);

export const migrationRunStatusEnum = pgEnum("migration_run_status", [
  "previewed",
  "superseded",
  "committing",
  "committed",
]);

/**
 * Privacy-safe ledger for supervised clinic migrations.
 *
 * Raw files and row-level errors never belong here. The ledger stores only a
 * SHA-256 file identity, aggregate counts, lifecycle state, and actor. That is
 * enough to prove what was reviewed and committed without making another copy
 * of clinic data.
 */
export const migrationRuns = pgTable(
  "migration_runs",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    mode: migrationRunModeEnum("mode").notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    fileHash: varchar("file_hash", { length: 64 }).notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    status: migrationRunStatusEnum("status").notNull().default("previewed"),
    sourceRowCount: integer("source_row_count").notNull().default(0),
    plannedInsertCount: integer("planned_insert_count").notNull().default(0),
    plannedReconcileCount: integer("planned_reconcile_count")
      .notNull()
      .default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    unmatchedCount: integer("unmatched_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    importedCount: integer("imported_count").notNull().default(0),
    reconciledCount: integer("reconciled_count").notNull().default(0),
    previewExpiresAt: timestamp("preview_expires_at", {
      withTimezone: true,
    }).notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    committedBy: uuid("committed_by").references(() => users.id),
  },
  (table) => ({
    activePreviewUq: uniqueIndex("migration_runs_active_preview_uq")
      .on(table.practiceId, table.mode)
      .where(sql`${table.status} = 'previewed' and ${table.deletedAt} is null`),
    practiceStatusIdx: index("migration_runs_practice_status_idx").on(
      table.practiceId,
      table.status,
      table.updatedAt,
    ),
    createdByIdx: index("migration_runs_created_by_idx").on(table.createdBy),
    committedByIdx: index("migration_runs_committed_by_idx").on(
      table.committedBy,
    ),
    pendingExpiryIdx: index("migration_runs_pending_expiry_idx")
      .on(table.previewExpiresAt)
      .where(sql`${table.status} = 'previewed'`),
    fileHashCheck: check(
      "migration_runs_file_hash_check",
      sql`${table.fileHash} ~ '^[0-9a-f]{64}$'`,
    ),
    fileSizeCheck: check(
      "migration_runs_file_size_check",
      sql`${table.fileSizeBytes} between 1 and 5000000`,
    ),
    sourceCheck: check(
      "migration_runs_source_check",
      sql`${table.source} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`,
    ),
    previewExpiryCheck: check(
      "migration_runs_preview_expiry_check",
      sql`${table.previewExpiresAt} > ${table.createdAt}`,
    ),
    committedStateCheck: check(
      "migration_runs_committed_state_check",
      sql`(${table.status} <> 'committed' or (${table.committedAt} is not null and ${table.committedBy} is not null))`,
    ),
    supersededStateCheck: check(
      "migration_runs_superseded_state_check",
      sql`(${table.status} <> 'superseded' or (${table.supersededAt} is not null and ${table.committedAt} is null and ${table.committedBy} is null))`,
    ),
    countsCheck: check(
      "migration_runs_counts_check",
      sql`${table.sourceRowCount} >= 0
        and ${table.plannedInsertCount} >= 0
        and ${table.plannedReconcileCount} >= 0
        and ${table.duplicateCount} >= 0
        and ${table.unmatchedCount} >= 0
        and ${table.errorCount} >= 0
        and ${table.importedCount} >= 0
        and ${table.reconciledCount} >= 0`,
    ),
  }),
);

export const migrationRunsRelations = relations(migrationRuns, ({ one }) => ({
  practice: one(practices, {
    fields: [migrationRuns.practiceId],
    references: [practices.id],
  }),
  creator: one(users, {
    fields: [migrationRuns.createdBy],
    references: [users.id],
  }),
}));
