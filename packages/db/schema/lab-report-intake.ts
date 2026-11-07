import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  index,
  uniqueIndex,
  foreignKey,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";
import { files } from "./files";
import { patients } from "./patients";
import { users } from "./users";

/** Original documents are receipts, not clinical observations. Matching and
 * review are append-only decisions; importing never creates interpreted values. */
export const labReportReceipts = pgTable(
  "lab_report_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    fileId: uuid("file_id").notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    receivedBy: uuid("received_by").notNull(),
    source: varchar("source", { length: 32 })
      .notNull()
      .default("manual_upload"),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => labReportReceipts.id,
    ),
  },
  (t) => ({
    tenantId: uniqueIndex("lab_report_receipts_tenant_id_uq").on(
      t.practiceId,
      t.id,
    ),
    digest: uniqueIndex("lab_report_receipts_digest_uq").on(
      t.practiceId,
      t.checksumSha256,
    ),
    file: uniqueIndex("lab_report_receipts_file_uq").on(t.practiceId, t.fileId),
    revisions: index("lab_report_receipts_revisions_idx").on(
      t.practiceId,
      t.supersedesId,
    ),
    inbox: index("lab_report_receipts_inbox_idx").on(
      t.practiceId,
      t.createdAt,
      t.id,
    ),
    fileTenant: foreignKey({
      columns: [t.practiceId, t.fileId],
      foreignColumns: [files.practiceId, files.id],
      name: "lab_report_receipts_file_tenant_fk",
    }),
    actorTenant: foreignKey({
      columns: [t.practiceId, t.receivedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_report_receipts_actor_tenant_fk",
    }),
    previousTenant: foreignKey({
      columns: [t.practiceId, t.supersedesId],
      foreignColumns: [t.practiceId, t.id],
      name: "lab_report_receipts_previous_tenant_fk",
    }),
    digestShape: check(
      "lab_report_receipts_digest_check",
      sql`${t.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    sourceShape: check(
      "lab_report_receipts_source_check",
      sql`${t.source} = 'manual_upload'`,
    ),
    previousShape: check(
      "lab_report_receipts_previous_check",
      sql`${t.supersedesId} is null or ${t.supersedesId} <> ${t.id}`,
    ),
  }),
);

export const labReportDecisions = pgTable(
  "lab_report_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    reportId: uuid("report_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorId: uuid("actor_id").notNull(),
    version: integer("version").notNull(),
    operationId: uuid("operation_id").notNull(),
    state: varchar("state", { length: 16 })
      .$type<"matched" | "reviewed" | "unmatched" | "dismissed">()
      .notNull(),
    patientId: uuid("patient_id"),
    reason: varchar("reason", { length: 500 }),
  },
  (t) => ({
    versionUq: uniqueIndex("lab_report_decisions_version_uq").on(
      t.reportId,
      t.version,
    ),
    operationUq: uniqueIndex("lab_report_decisions_operation_uq").on(
      t.practiceId,
      t.operationId,
    ),
    latestIdx: index("lab_report_decisions_latest_idx").on(
      t.practiceId,
      t.reportId,
      t.version,
    ),
    patientIdx: index("lab_report_decisions_patient_idx").on(
      t.practiceId,
      t.patientId,
    ),
    reportTenant: foreignKey({
      columns: [t.practiceId, t.reportId],
      foreignColumns: [labReportReceipts.practiceId, labReportReceipts.id],
      name: "lab_report_decisions_report_tenant_fk",
    }),
    patientTenant: foreignKey({
      columns: [t.practiceId, t.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "lab_report_decisions_patient_tenant_fk",
    }),
    actorTenant: foreignKey({
      columns: [t.practiceId, t.actorId],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_report_decisions_actor_tenant_fk",
    }),
    versionCheck: check(
      "lab_report_decisions_version_check",
      sql`${t.version} > 0`,
    ),
    stateCheck: check(
      "lab_report_decisions_state_check",
      sql`(${t.state} in ('matched', 'reviewed') and ${t.patientId} is not null) or (${t.state} in ('unmatched', 'dismissed') and ${t.patientId} is null and ${t.reason} is not null and length(trim(${t.reason})) > 0)`,
    ),
  }),
);
export const labReportReceiptsRelations = relations(
  labReportReceipts,
  ({ many }) => ({ decisions: many(labReportDecisions) }),
);
export const labReportDecisionsRelations = relations(
  labReportDecisions,
  ({ one }) => ({
    report: one(labReportReceipts, {
      fields: [labReportDecisions.reportId],
      references: [labReportReceipts.id],
    }),
  }),
);
