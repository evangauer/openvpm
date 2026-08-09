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
import { soapNotes } from "./clinical";
import { practices } from "./practices";
import { users } from "./users";

/**
 * Immutable SOAP amendment lineage. A replacement is a new finalized SOAP
 * note; this evidence row links it to the retained entered-in-error source.
 */
export const soapNoteReplacements = pgTable(
  "soap_note_replacements",
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
    sourceSoapNoteId: uuid("source_soap_note_id")
      .notNull()
      .references(() => soapNotes.id),
    replacementSoapNoteId: uuid("replacement_soap_note_id")
      .notNull()
      .references(() => soapNotes.id),
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
    sourceHistoryIdx: index("soap_note_replacements_source_history_idx").on(
      table.practiceId,
      table.sourceSoapNoteId,
      table.createdAt,
      table.id,
    ),
    sourceUq: uniqueIndex("soap_note_replacements_source_uq").on(
      table.practiceId,
      table.sourceSoapNoteId,
    ),
    replacementUq: uniqueIndex("soap_note_replacements_replacement_uq").on(
      table.practiceId,
      table.replacementSoapNoteId,
    ),
    operationUq: uniqueIndex("soap_note_replacements_operation_uq").on(
      table.practiceId,
      table.operationId,
    ),
    sourceTenantFk: foreignKey({
      columns: [table.practiceId, table.sourceSoapNoteId],
      foreignColumns: [soapNotes.practiceId, soapNotes.id],
      name: "soap_note_replacements_source_tenant_fk",
    }),
    replacementTenantFk: foreignKey({
      columns: [table.practiceId, table.replacementSoapNoteId],
      foreignColumns: [soapNotes.practiceId, soapNotes.id],
      name: "soap_note_replacements_replacement_tenant_fk",
    }),
    correctionSourceTenantFk: foreignKey({
      columns: [table.practiceId, table.correctionId, table.sourceSoapNoteId],
      foreignColumns: [
        clinicalRecordCorrections.practiceId,
        clinicalRecordCorrections.id,
        clinicalRecordCorrections.soapNoteId,
      ],
      name: "soap_note_replacements_correction_source_tenant_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorId],
      foreignColumns: [users.practiceId, users.id],
      name: "soap_note_replacements_actor_tenant_fk",
    }),
    shapeCheck: check(
      "soap_note_replacements_shape_check",
      sql`${table.sourceSoapNoteId} <> ${table.replacementSoapNoteId}
        and ${table.actorName} = btrim(${table.actorName})
        and length(btrim(${table.actorName})) between 1 and 255
        and ${table.operationPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const soapNoteReplacementsRelations = relations(
  soapNoteReplacements,
  ({ one }) => ({
    practice: one(practices, {
      fields: [soapNoteReplacements.practiceId],
      references: [practices.id],
    }),
    correction: one(clinicalRecordCorrections, {
      fields: [soapNoteReplacements.correctionId],
      references: [clinicalRecordCorrections.id],
    }),
    source: one(soapNotes, {
      fields: [soapNoteReplacements.sourceSoapNoteId],
      references: [soapNotes.id],
      relationName: "soapReplacementSource",
    }),
    replacement: one(soapNotes, {
      fields: [soapNoteReplacements.replacementSoapNoteId],
      references: [soapNotes.id],
      relationName: "soapReplacementNote",
    }),
    actor: one(users, {
      fields: [soapNoteReplacements.actorId],
      references: [users.id],
    }),
  }),
);
