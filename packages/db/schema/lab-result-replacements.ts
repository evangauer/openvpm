import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { clinicalRecordCorrections } from "./clinical-corrections";
import { labResults } from "./clinical";
import { practices } from "./practices";
import { users } from "./users";

/**
 * Immutable amendment lineage. A replacement is a new lab result with its own
 * evidence ledger; this row links it to the retained entered-in-error source.
 */
export const labResultReplacements = pgTable(
  "lab_result_replacements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    correctionId: uuid("correction_id")
      .notNull()
      .references(() => clinicalRecordCorrections.id),
    sourceLabResultId: uuid("source_lab_result_id")
      .notNull()
      .references(() => labResults.id),
    replacementLabResultId: uuid("replacement_lab_result_id")
      .notNull()
      .references(() => labResults.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    actorName: varchar("actor_name", { length: 255 }).notNull(),
    operationId: uuid("operation_id").notNull(),
    operationPayloadHash: varchar("operation_payload_hash", {
      length: 64,
    }).notNull(),
  },
  (table) => ({
    sourceHistoryIdx: index("lab_result_replacements_source_history_idx").on(
      table.practiceId,
      table.sourceLabResultId,
      table.createdAt,
      table.id,
    ),
    sourceUq: uniqueIndex("lab_result_replacements_source_uq").on(
      table.practiceId,
      table.sourceLabResultId,
    ),
    replacementUq: uniqueIndex("lab_result_replacements_replacement_uq").on(
      table.practiceId,
      table.replacementLabResultId,
    ),
    operationUq: uniqueIndex("lab_result_replacements_operation_uq").on(
      table.practiceId,
      table.operationId,
    ),
    sourceTenantFk: foreignKey({
      columns: [table.practiceId, table.sourceLabResultId],
      foreignColumns: [labResults.practiceId, labResults.id],
      name: "lab_result_replacements_source_tenant_fk",
    }),
    replacementTenantFk: foreignKey({
      columns: [table.practiceId, table.replacementLabResultId],
      foreignColumns: [labResults.practiceId, labResults.id],
      name: "lab_result_replacements_replacement_tenant_fk",
    }),
    correctionSourceTenantFk: foreignKey({
      columns: [table.practiceId, table.correctionId, table.sourceLabResultId],
      foreignColumns: [
        clinicalRecordCorrections.practiceId,
        clinicalRecordCorrections.id,
        clinicalRecordCorrections.labResultId,
      ],
      name: "lab_result_replacements_correction_source_tenant_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorId],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_result_replacements_actor_tenant_fk",
    }),
    shapeCheck: check(
      "lab_result_replacements_shape_check",
      sql`${table.sourceLabResultId} <> ${table.replacementLabResultId}
        and length(btrim(${table.actorName})) between 1 and 255
        and ${table.operationPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const labResultReplacementsRelations = relations(
  labResultReplacements,
  ({ one }) => ({
    practice: one(practices, {
      fields: [labResultReplacements.practiceId],
      references: [practices.id],
    }),
    correction: one(clinicalRecordCorrections, {
      fields: [labResultReplacements.correctionId],
      references: [clinicalRecordCorrections.id],
    }),
    source: one(labResults, {
      fields: [labResultReplacements.sourceLabResultId],
      references: [labResults.id],
      relationName: "labReplacementSource",
    }),
    replacement: one(labResults, {
      fields: [labResultReplacements.replacementLabResultId],
      references: [labResults.id],
      relationName: "labReplacementResult",
    }),
    actor: one(users, {
      fields: [labResultReplacements.actorId],
      references: [users.id],
    }),
  }),
);
