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
import { appointments } from "./scheduling";
import { patients } from "./patients";
import { practices } from "./practices";
import {
  labResults,
  soapNotes,
  vaccinationRecords,
  vitalSigns,
} from "./clinical";
import { users } from "./users";

export const clinicalCorrectionRecordTypeEnum = pgEnum(
  "clinical_correction_record_type",
  ["soap_note", "vital_sign", "vaccination_record", "lab_result"],
);

export const clinicalCorrectionActionEnum = pgEnum(
  "clinical_correction_action",
  ["entered_in_error"],
);

/**
 * Append-only clinical correction events. The source row remains untouched so
 * the chart preserves exactly what was originally recorded.
 */
export const clinicalRecordCorrections = pgTable(
  "clinical_record_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    recordType: clinicalCorrectionRecordTypeEnum("record_type").notNull(),
    action: clinicalCorrectionActionEnum("action")
      .notNull()
      .default("entered_in_error"),
    soapNoteId: uuid("soap_note_id").references(() => soapNotes.id),
    vitalSignId: uuid("vital_sign_id").references(() => vitalSigns.id),
    vaccinationRecordId: uuid("vaccination_record_id").references(
      () => vaccinationRecords.id,
    ),
    labResultId: uuid("lab_result_id").references(() => labResults.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    reason: varchar("reason", { length: 1000 }).notNull(),
    correctedBy: uuid("corrected_by")
      .notNull()
      .references(() => users.id),
    correctedByName: varchar("corrected_by_name", { length: 255 }).notNull(),
    operationId: uuid("operation_id"),
    operationPayloadHash: varchar("operation_payload_hash", { length: 64 }),
  },
  (table) => ({
    practicePatientHistoryIdx: index(
      "clinical_record_corrections_practice_patient_history_idx",
    ).on(table.practiceId, table.patientId, table.createdAt, table.id),
    practiceAppointmentHistoryIdx: index(
      "clinical_record_corrections_practice_appointment_history_idx",
    ).on(table.practiceId, table.appointmentId, table.createdAt, table.id),
    practiceTypeHistoryIdx: index(
      "clinical_record_corrections_practice_type_history_idx",
    ).on(table.practiceId, table.recordType, table.createdAt, table.id),
    soapNoteUq: uniqueIndex("clinical_record_corrections_soap_note_uq")
      .on(table.practiceId, table.soapNoteId)
      .where(sql`${table.soapNoteId} is not null`),
    vitalSignUq: uniqueIndex("clinical_record_corrections_vital_sign_uq")
      .on(table.practiceId, table.vitalSignId)
      .where(sql`${table.vitalSignId} is not null`),
    vaccinationRecordUq: uniqueIndex(
      "clinical_record_corrections_vaccination_record_uq",
    )
      .on(table.practiceId, table.vaccinationRecordId)
      .where(sql`${table.vaccinationRecordId} is not null`),
    labResultUq: uniqueIndex("clinical_record_corrections_lab_result_uq")
      .on(table.practiceId, table.labResultId)
      .where(sql`${table.labResultId} is not null`),
    operationUq: uniqueIndex("clinical_record_corrections_operation_uq")
      .on(table.practiceId, table.operationId)
      .where(sql`${table.operationId} is not null`),
    practiceRecordLabSourceUq: uniqueIndex(
      "clinical_record_corrections_practice_record_lab_source_uq",
    ).on(table.practiceId, table.id, table.labResultId),
    appointmentPracticeFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "clinical_record_corrections_practice_appointment_fk",
    }),
    patientPracticeFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "clinical_record_corrections_practice_patient_fk",
    }),
    actorPracticeFk: foreignKey({
      columns: [table.practiceId, table.correctedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "clinical_record_corrections_practice_actor_fk",
    }),
    soapSourceFk: foreignKey({
      columns: [table.practiceId, table.soapNoteId],
      foreignColumns: [soapNotes.practiceId, soapNotes.id],
      name: "clinical_record_corrections_soap_source_fk",
    }),
    vitalSourceFk: foreignKey({
      columns: [table.practiceId, table.vitalSignId],
      foreignColumns: [vitalSigns.practiceId, vitalSigns.id],
      name: "clinical_record_corrections_vital_source_fk",
    }),
    vaccinationSourceFk: foreignKey({
      columns: [table.practiceId, table.vaccinationRecordId],
      foreignColumns: [vaccinationRecords.practiceId, vaccinationRecords.id],
      name: "clinical_record_corrections_vaccination_source_fk",
    }),
    labResultSourceFk: foreignKey({
      columns: [table.practiceId, table.labResultId],
      foreignColumns: [labResults.practiceId, labResults.id],
      name: "clinical_record_corrections_lab_result_source_fk",
    }),
    sourceTypeCheck: check(
      "clinical_record_corrections_source_type_check",
      sql`(
        ${table.recordType} = 'soap_note'
        and ${table.soapNoteId} is not null
        and ${table.vitalSignId} is null
        and ${table.vaccinationRecordId} is null
        and ${table.labResultId} is null
      ) or (
        ${table.recordType} = 'vital_sign'
        and ${table.vitalSignId} is not null
        and ${table.soapNoteId} is null
        and ${table.vaccinationRecordId} is null
        and ${table.labResultId} is null
      ) or (
        ${table.recordType} = 'vaccination_record'
        and ${table.vaccinationRecordId} is not null
        and ${table.soapNoteId} is null
        and ${table.vitalSignId} is null
        and ${table.labResultId} is null
      ) or (
        ${table.recordType} = 'lab_result'
        and ${table.labResultId} is not null
        and ${table.soapNoteId} is null
        and ${table.vitalSignId} is null
        and ${table.vaccinationRecordId} is null
      )`,
    ),
    operationShapeCheck: check(
      "clinical_record_corrections_operation_shape_check",
      sql`(
          ${table.recordType} = 'lab_result'
          and ${table.operationId} is not null
          and ${table.operationPayloadHash} ~ '^[0-9a-f]{64}$'
        ) or (
          ${table.recordType} <> 'lab_result'
          and ${table.operationId} is null
          and ${table.operationPayloadHash} is null
        )`,
    ),
    reasonLengthCheck: check(
      "clinical_record_corrections_reason_length_check",
      sql`length(btrim(${table.reason})) between 5 and 1000`,
    ),
    actorNameCheck: check(
      "clinical_record_corrections_actor_name_check",
      sql`length(btrim(${table.correctedByName})) between 1 and 255`,
    ),
  }),
);

export const clinicalRecordCorrectionsRelations = relations(
  clinicalRecordCorrections,
  ({ one }) => ({
    practice: one(practices, {
      fields: [clinicalRecordCorrections.practiceId],
      references: [practices.id],
    }),
    patient: one(patients, {
      fields: [clinicalRecordCorrections.patientId],
      references: [patients.id],
    }),
    appointment: one(appointments, {
      fields: [clinicalRecordCorrections.appointmentId],
      references: [appointments.id],
    }),
    actor: one(users, {
      fields: [clinicalRecordCorrections.correctedBy],
      references: [users.id],
    }),
    soapNote: one(soapNotes, {
      fields: [clinicalRecordCorrections.soapNoteId],
      references: [soapNotes.id],
    }),
    vitalSign: one(vitalSigns, {
      fields: [clinicalRecordCorrections.vitalSignId],
      references: [vitalSigns.id],
    }),
    vaccinationRecord: one(vaccinationRecords, {
      fields: [clinicalRecordCorrections.vaccinationRecordId],
      references: [vaccinationRecords.id],
    }),
    labResult: one(labResults, {
      fields: [clinicalRecordCorrections.labResultId],
      references: [labResults.id],
    }),
  }),
);
