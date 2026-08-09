import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  numeric,
  date,
  boolean,
  check,
  foreignKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { users } from "./users";
import { patients } from "./patients";
import { appointments } from "./scheduling";

export const problemStatusEnum = pgEnum("problem_status", [
  "active",
  "resolved",
  "chronic",
]);

export const labStatusEnum = pgEnum("lab_status", [
  "pending",
  "completed",
  "reviewed",
]);

export const labResultFlagEnum = pgEnum("lab_result_flag", [
  "unknown",
  "normal",
  "abnormal",
  "critical",
]);

export const labFollowUpStatusEnum = pgEnum("lab_follow_up_status", [
  "not_required",
  "open",
  "completed",
]);

export const noteTypeEnum = pgEnum("note_type", [
  "general",
  "follow_up",
  "phone_call",
]);

export const caseStatusEnum = pgEnum("case_status", ["open", "closed"]);

export const treatmentPlanStatusEnum = pgEnum("treatment_plan_status", [
  "active",
  "completed",
  "discontinued",
]);

export const treatmentPlanItemStatusEnum = pgEnum(
  "treatment_plan_item_status",
  ["pending", "in_progress", "done", "skipped"],
);

export const soapNoteStatusEnum = pgEnum("soap_note_status", [
  "draft",
  "finalized",
]);

export const soapNotes = pgTable(
  "soap_notes",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    authorName: varchar("author_name", { length: 255 }).notNull(),
    status: soapNoteStatusEnum("status").notNull().default("finalized"),
    revision: integer("revision").notNull().default(1),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedBy: uuid("finalized_by"),
    finalizerName: varchar("finalizer_name", { length: 255 }),
    subjective: text("subjective"),
    objective: text("objective"),
    assessment: text("assessment"),
    plan: text("plan"),
    // True for notes brought in by a migration import. Historical records have
    // no OpenVPM author, so authorId holds the importing admin; this flag lets
    // the record show "Imported" instead of implying that admin wrote the note.
    imported: boolean("imported").notNull().default(false),
    // Import-only content identity. Clinic-authored notes keep this null so
    // clinically legitimate repeated notes remain representable.
    importFingerprint: varchar("import_fingerprint", { length: 64 }),
  },
  (table) => ({
    patientIdx: index("soap_notes_patient_idx").on(table.patientId),
    practiceRecordUq: uniqueIndex("soap_notes_practice_record_uq").on(
      table.practiceId,
      table.id,
    ),
    importFingerprintUq: uniqueIndex("soap_notes_import_fingerprint_uq")
      .on(table.practiceId, table.importFingerprint)
      .where(
        sql`${table.importFingerprint} is not null and ${table.deletedAt} is null`,
      ),
    importFingerprintCheck: check(
      "soap_notes_import_fingerprint_check",
      sql`${table.importFingerprint} is null or ${table.importFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    practiceIdx: index("soap_notes_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    appointmentIdx: index("soap_notes_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.deletedAt,
    ),
    activeAppointmentDraftUq: uniqueIndex(
      "soap_notes_active_appointment_draft_uq",
    )
      .on(table.practiceId, table.appointmentId)
      .where(
        sql`${table.status} = 'draft' and ${table.appointmentId} is not null and ${table.deletedAt} is null`,
      ),
    patientPracticeFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "soap_notes_practice_patient_fk",
    }),
    appointmentPracticeFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "soap_notes_practice_appointment_fk",
    }),
    authorPracticeFk: foreignKey({
      columns: [table.practiceId, table.authorId],
      foreignColumns: [users.practiceId, users.id],
      name: "soap_notes_practice_author_fk",
    }),
    finalizerPracticeFk: foreignKey({
      columns: [table.practiceId, table.finalizedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "soap_notes_practice_finalizer_fk",
    }),
    revisionCheck: check(
      "soap_notes_revision_check",
      sql`${table.revision} >= 1`,
    ),
    authorNameCheck: check(
      "soap_notes_author_name_check",
      sql`length(btrim(${table.authorName})) between 1 and 255`,
    ),
    lifecycleCheck: check(
      "soap_notes_lifecycle_check",
      sql`(
        ${table.status} = 'draft'
        and ${table.finalizedAt} is null
        and ${table.finalizedBy} is null
        and ${table.finalizerName} is null
        and ${table.imported} = false
      ) or (
        ${table.status} = 'finalized'
        and ${table.finalizedAt} is not null
        and ${table.finalizedBy} is not null
        and length(btrim(${table.finalizerName})) between 1 and 255
      )`,
    ),
  }),
);

/** Append-only clarifications to an immutable finalized SOAP note. */
export const soapNoteAddenda = pgTable(
  "soap_note_addenda",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    soapNoteId: uuid("soap_note_id").notNull(),
    authorId: uuid("author_id").notNull(),
    authorName: varchar("author_name", { length: 255 }).notNull(),
    content: text("content").notNull(),
    operationId: uuid("operation_id").notNull(),
    operationPayloadHash: varchar("operation_payload_hash", {
      length: 64,
    }).notNull(),
  },
  (table) => ({
    historyIdx: index("soap_note_addenda_history_idx").on(
      table.practiceId,
      table.soapNoteId,
      table.createdAt,
      table.id,
    ),
    operationUq: uniqueIndex("soap_note_addenda_operation_uq").on(
      table.practiceId,
      table.operationId,
    ),
    sourcePracticeFk: foreignKey({
      columns: [table.practiceId, table.soapNoteId],
      foreignColumns: [soapNotes.practiceId, soapNotes.id],
      name: "soap_note_addenda_practice_source_fk",
    }),
    authorPracticeFk: foreignKey({
      columns: [table.practiceId, table.authorId],
      foreignColumns: [users.practiceId, users.id],
      name: "soap_note_addenda_practice_author_fk",
    }),
    contentCheck: check(
      "soap_note_addenda_content_check",
      sql`length(btrim(${table.content})) between 1 and 10000`,
    ),
    authorNameCheck: check(
      "soap_note_addenda_author_name_check",
      sql`length(btrim(${table.authorName})) between 1 and 255`,
    ),
    payloadHashCheck: check(
      "soap_note_addenda_payload_hash_check",
      sql`${table.operationPayloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const vaccinationRecords = pgTable(
  "vaccination_records",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    vaccineName: varchar("vaccine_name", { length: 255 }).notNull(),
    // Import-only dose identity. Normal administered doses keep this null.
    importFingerprint: varchar("import_fingerprint", { length: 64 }),
    lotNumber: varchar("lot_number", { length: 64 }),
    manufacturer: varchar("manufacturer", { length: 128 }),
    administeredBy: uuid("administered_by").references(() => users.id),
    administeredAt: timestamp("administered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    nextDueDate: date("next_due_date"),
    certificateUrl: varchar("certificate_url", { length: 512 }),
  },
  (table) => ({
    patientIdx: index("vaccination_records_patient_idx").on(
      table.patientId,
      table.nextDueDate,
    ),
    practiceRecordUq: uniqueIndex("vaccination_records_practice_record_uq").on(
      table.practiceId,
      table.id,
    ),
    practiceDueIdx: index("vaccination_records_practice_due_idx").on(
      table.practiceId,
      table.nextDueDate,
      table.deletedAt,
    ),
    appointmentIdx: index("vaccination_records_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.deletedAt,
    ),
    visitSourceUq: uniqueIndex("vaccination_records_visit_source_uq").on(
      table.practiceId,
      table.appointmentId,
      table.id,
    ),
    importFingerprintUq: uniqueIndex(
      "vaccination_records_import_fingerprint_uq",
    )
      .on(table.practiceId, table.importFingerprint)
      .where(
        sql`${table.importFingerprint} is not null and ${table.deletedAt} is null`,
      ),
    importFingerprintCheck: check(
      "vaccination_records_import_fingerprint_check",
      sql`${table.importFingerprint} is null or ${table.importFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    appointmentPracticeFk: foreignKey({
      columns: [table.practiceId, table.appointmentId],
      foreignColumns: [appointments.practiceId, appointments.id],
      name: "vaccination_records_practice_appointment_fk",
    }),
  }),
);

export const labResults = pgTable(
  "lab_results",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    creationOperationId: uuid("creation_operation_id"),
    creationPayloadHash: varchar("creation_payload_hash", { length: 64 }),
    testName: varchar("test_name", { length: 255 }).notNull(),
    resultValue: varchar("result_value", { length: 128 }),
    unit: varchar("unit", { length: 32 }),
    referenceRangeLow: numeric("reference_range_low", {
      precision: 10,
      scale: 3,
    }),
    referenceRangeHigh: numeric("reference_range_high", {
      precision: 10,
      scale: 3,
    }),
    status: labStatusEnum("status").notNull().default("pending"),
    resultFlag: labResultFlagEnum("result_flag").notNull().default("unknown"),
    orderedBy: uuid("ordered_by").references(() => users.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    followUpStatus: labFollowUpStatusEnum("follow_up_status")
      .notNull()
      .default("not_required"),
    followUpAssignedTo: uuid("follow_up_assigned_to").references(
      () => users.id,
    ),
    followUpDueAt: timestamp("follow_up_due_at", { withTimezone: true }),
    followUpNote: varchar("follow_up_note", { length: 1000 }),
    followUpCompletedBy: uuid("follow_up_completed_by").references(
      () => users.id,
    ),
    followUpCompletedAt: timestamp("follow_up_completed_at", {
      withTimezone: true,
    }),
    followUpOutcome: varchar("follow_up_outcome", { length: 1000 }),
  },
  (table) => ({
    patientIdx: index("lab_results_patient_idx").on(
      table.patientId,
      table.status,
    ),
    practiceStatusIdx: index("lab_results_practice_status_idx").on(
      table.practiceId,
      table.status,
      table.deletedAt,
    ),
    reviewInboxIdx: index("lab_results_review_inbox_idx").on(
      table.practiceId,
      table.status,
      table.resultFlag,
      table.completedAt,
      table.id,
    ),
    followUpInboxIdx: index("lab_results_follow_up_inbox_idx").on(
      table.practiceId,
      table.followUpStatus,
      table.followUpAssignedTo,
      table.followUpDueAt,
      table.id,
    ),
    practiceRecordUq: uniqueIndex("lab_results_practice_record_uq").on(
      table.practiceId,
      table.id,
    ),
    creationOperationUq: uniqueIndex("lab_results_creation_operation_uq").on(
      table.practiceId,
      table.creationOperationId,
    ),
    appointmentIdx: index("lab_results_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.deletedAt,
    ),
    visitSourceUq: uniqueIndex("lab_results_visit_source_uq").on(
      table.practiceId,
      table.appointmentId,
      table.id,
    ),
    patientPracticeFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "lab_results_practice_patient_fk",
    }),
    appointmentPracticeFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "lab_results_practice_appointment_fk",
    }),
    orderedByPracticeFk: foreignKey({
      columns: [table.practiceId, table.orderedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_results_practice_ordered_by_fk",
    }),
    reviewedByPracticeFk: foreignKey({
      columns: [table.practiceId, table.reviewedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_results_practice_reviewed_by_fk",
    }),
    followUpAssignedPracticeFk: foreignKey({
      columns: [table.practiceId, table.followUpAssignedTo],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_results_practice_follow_up_assigned_fk",
    }),
    followUpCompletedPracticeFk: foreignKey({
      columns: [table.practiceId, table.followUpCompletedBy],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_results_practice_follow_up_completed_fk",
    }),
    lifecycleShapeCheck: check(
      "lab_results_lifecycle_shape_check",
      sql`(
          ${table.status} = 'pending'
          and ${table.completedAt} is null
          and ${table.reviewedAt} is null
          and ${table.reviewedBy} is null
        ) or (
          ${table.status} = 'completed'
          and ${table.completedAt} is not null
          and ${table.reviewedAt} is null
          and ${table.reviewedBy} is null
        ) or (
          ${table.status} = 'reviewed'
          and ${table.completedAt} is not null
          and ${table.reviewedAt} is not null
          and ${table.reviewedBy} is not null
        )`,
    ),
    creationOperationShapeCheck: check(
      "lab_results_creation_operation_shape_check",
      sql`(${table.creationOperationId} is null and ${table.creationPayloadHash} is null)
        or (${table.creationOperationId} is not null and ${table.creationPayloadHash} ~ '^[0-9a-f]{64}$')`,
    ),
    resultShapeCheck: check(
      "lab_results_result_shape_check",
      sql`(
          ${table.status} = 'pending'
          and ${table.resultValue} is null
          and ${table.unit} is null
          and ${table.referenceRangeLow} is null
          and ${table.referenceRangeHigh} is null
          and ${table.resultFlag} = 'unknown'
        ) or (
          ${table.status} in ('completed', 'reviewed')
          and length(btrim(coalesce(${table.resultValue}, ''))) > 0
        )`,
    ),
    followUpShapeCheck: check(
      "lab_results_follow_up_shape_check",
      sql`(${table.status} <> 'pending' or ${table.followUpStatus} = 'not_required')
        and not (
          ${table.status} = 'reviewed'
          and ${table.resultFlag} = 'critical'
          and ${table.followUpStatus} = 'not_required'
        )
        and not (
          ${table.resultFlag} = 'critical'
          and ${table.followUpStatus} in ('open', 'completed')
          and ${table.followUpDueAt} is null
        )
        and ((
          ${table.followUpStatus} = 'not_required'
          and ${table.followUpAssignedTo} is null
          and ${table.followUpDueAt} is null
          and ${table.followUpNote} is null
          and ${table.followUpCompletedBy} is null
          and ${table.followUpCompletedAt} is null
          and ${table.followUpOutcome} is null
        ) or (
          ${table.followUpStatus} = 'open'
          and ${table.followUpAssignedTo} is not null
          and ${table.followUpCompletedBy} is null
          and ${table.followUpCompletedAt} is null
          and ${table.followUpOutcome} is null
        ) or (
          ${table.followUpStatus} = 'completed'
          and ${table.followUpAssignedTo} is not null
          and ${table.followUpCompletedBy} is not null
          and ${table.followUpCompletedAt} is not null
          and length(btrim(coalesce(${table.followUpOutcome}, ''))) between 3 and 1000
        ))`,
    ),
  }),
);

export const procedures = pgTable(
  "procedures",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    performedBy: uuid("performed_by").references(() => users.id),
    anesthesiaUsed: text("anesthesia_used"),
    durationMinutes: integer("duration_minutes"),
    notes: text("notes"),
  },
  (table) => ({
    patientIdx: index("procedures_patient_idx").on(table.patientId),
    practiceIdx: index("procedures_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    appointmentIdx: index("procedures_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.deletedAt,
    ),
    visitSourceUq: uniqueIndex("procedures_visit_source_uq").on(
      table.practiceId,
      table.appointmentId,
      table.id,
    ),
    appointmentPracticeFk: foreignKey({
      columns: [table.practiceId, table.appointmentId],
      foreignColumns: [appointments.practiceId, appointments.id],
      name: "procedures_practice_appointment_fk",
    }),
  }),
);

export const clinicalNotes = pgTable(
  "clinical_notes",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    noteType: noteTypeEnum("note_type").notNull().default("general"),
    content: text("content").notNull(),
  },
  (table) => ({
    patientIdx: index("clinical_notes_patient_idx").on(
      table.patientId,
      table.noteType,
    ),
    practiceIdx: index("clinical_notes_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
  }),
);

export const problemList = pgTable(
  "problem_list",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    description: varchar("description", { length: 500 }).notNull(),
    status: problemStatusEnum("status").notNull().default("active"),
    onsetDate: date("onset_date"),
    resolvedDate: date("resolved_date"),
  },
  (table) => ({
    patientStatusIdx: index("problem_list_patient_status_idx").on(
      table.patientId,
      table.status,
    ),
    practiceStatusIdx: index("problem_list_practice_status_idx").on(
      table.practiceId,
      table.status,
      table.deletedAt,
    ),
  }),
);

export const vitalSigns = pgTable(
  "vital_signs",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    recordedBy: uuid("recorded_by").references(() => users.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    temperatureC: numeric("temperature_c", { precision: 4, scale: 1 }),
    heartRateBpm: integer("heart_rate_bpm"),
    respiratoryRateBpm: integer("respiratory_rate_bpm"),
    weightKg: numeric("weight_kg", { precision: 8, scale: 3 }),
    /** Body condition score, 1-9 scale. */
    bodyConditionScore: integer("body_condition_score"),
    /** Pain score, 0-10 scale. */
    painScore: integer("pain_score"),
    mucousMembrane: varchar("mucous_membrane", { length: 64 }),
    capillaryRefillSec: numeric("capillary_refill_sec", {
      precision: 3,
      scale: 1,
    }),
    notes: text("notes"),
  },
  (table) => ({
    patientIdx: index("vital_signs_patient_idx").on(
      table.patientId,
      table.recordedAt,
    ),
    practiceRecordUq: uniqueIndex("vital_signs_practice_record_uq").on(
      table.practiceId,
      table.id,
    ),
    practiceIdx: index("vital_signs_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
    appointmentIdx: index("vital_signs_appointment_idx").on(
      table.practiceId,
      table.appointmentId,
      table.deletedAt,
      table.recordedAt,
    ),
    patientPracticeFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "vital_signs_practice_patient_fk",
    }),
    appointmentPracticeFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "vital_signs_practice_appointment_fk",
    }),
  }),
);

export const cases = pgTable(
  "cases",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    status: caseStatusEnum("status").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    primaryVetId: uuid("primary_vet_id").references(() => users.id),
  },
  (table) => ({
    patientStatusIdx: index("cases_patient_status_idx").on(
      table.patientId,
      table.status,
    ),
    practiceStatusIdx: index("cases_practice_status_idx").on(
      table.practiceId,
      table.status,
      table.deletedAt,
    ),
  }),
);

export const caseEntries = pgTable(
  "case_entries",
  {
    ...baseColumns(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    medicalRecordType: varchar("medical_record_type", { length: 64 }),
    medicalRecordId: uuid("medical_record_id"),
    notes: text("notes"),
  },
  (table) => ({
    caseIdx: index("case_entries_case_idx").on(table.caseId, table.deletedAt),
  }),
);

export const treatmentPlans = pgTable(
  "treatment_plans",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    problemId: uuid("problem_id").references(() => problemList.id),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    status: treatmentPlanStatusEnum("status").notNull().default("active"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (table) => ({
    patientIdx: index("treatment_plans_patient_idx").on(table.patientId),
    practiceIdx: index("treatment_plans_practice_idx").on(
      table.practiceId,
      table.deletedAt,
    ),
  }),
);

export const treatmentPlanItems = pgTable(
  "treatment_plan_items",
  {
    ...baseColumns(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => treatmentPlans.id),
    description: varchar("description", { length: 500 }).notNull(),
    instructions: text("instructions"),
    status: treatmentPlanItemStatusEnum("status").notNull().default("pending"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => ({
    planOrderIdx: index("treatment_plan_items_plan_order_idx").on(
      table.planId,
      table.deletedAt,
      table.sortOrder,
    ),
  }),
);

// Relations
export const soapNotesRelations = relations(soapNotes, ({ one }) => ({
  practice: one(practices, {
    fields: [soapNotes.practiceId],
    references: [practices.id],
  }),
  patient: one(patients, {
    fields: [soapNotes.patientId],
    references: [patients.id],
  }),
  appointment: one(appointments, {
    fields: [soapNotes.appointmentId],
    references: [appointments.id],
  }),
  author: one(users, {
    fields: [soapNotes.authorId],
    references: [users.id],
  }),
  finalizer: one(users, {
    fields: [soapNotes.finalizedBy],
    references: [users.id],
  }),
}));

export const soapNoteAddendaRelations = relations(
  soapNoteAddenda,
  ({ one }) => ({
    practice: one(practices, {
      fields: [soapNoteAddenda.practiceId],
      references: [practices.id],
    }),
    soapNote: one(soapNotes, {
      fields: [soapNoteAddenda.soapNoteId],
      references: [soapNotes.id],
    }),
    author: one(users, {
      fields: [soapNoteAddenda.authorId],
      references: [users.id],
    }),
  }),
);

export const vaccinationRecordsRelations = relations(
  vaccinationRecords,
  ({ one }) => ({
    practice: one(practices, {
      fields: [vaccinationRecords.practiceId],
      references: [practices.id],
    }),
    patient: one(patients, {
      fields: [vaccinationRecords.patientId],
      references: [patients.id],
    }),
    administeredByUser: one(users, {
      fields: [vaccinationRecords.administeredBy],
      references: [users.id],
    }),
  }),
);

export const labResultsRelations = relations(labResults, ({ one }) => ({
  practice: one(practices, {
    fields: [labResults.practiceId],
    references: [practices.id],
  }),
  patient: one(patients, {
    fields: [labResults.patientId],
    references: [patients.id],
  }),
  appointment: one(appointments, {
    fields: [labResults.appointmentId],
    references: [appointments.id],
  }),
  orderedByUser: one(users, {
    fields: [labResults.orderedBy],
    references: [users.id],
  }),
  reviewedByUser: one(users, {
    fields: [labResults.reviewedBy],
    references: [users.id],
  }),
}));

export const proceduresRelations = relations(procedures, ({ one }) => ({
  practice: one(practices, {
    fields: [procedures.practiceId],
    references: [practices.id],
  }),
  patient: one(patients, {
    fields: [procedures.patientId],
    references: [patients.id],
  }),
  appointment: one(appointments, {
    fields: [procedures.appointmentId],
    references: [appointments.id],
  }),
  performedByUser: one(users, {
    fields: [procedures.performedBy],
    references: [users.id],
  }),
}));

export const clinicalNotesRelations = relations(clinicalNotes, ({ one }) => ({
  practice: one(practices, {
    fields: [clinicalNotes.practiceId],
    references: [practices.id],
  }),
  patient: one(patients, {
    fields: [clinicalNotes.patientId],
    references: [patients.id],
  }),
  author: one(users, {
    fields: [clinicalNotes.authorId],
    references: [users.id],
  }),
}));

export const problemListRelations = relations(problemList, ({ one }) => ({
  practice: one(practices, {
    fields: [problemList.practiceId],
    references: [practices.id],
  }),
  patient: one(patients, {
    fields: [problemList.patientId],
    references: [patients.id],
  }),
}));

export const vitalSignsRelations = relations(vitalSigns, ({ one }) => ({
  practice: one(practices, {
    fields: [vitalSigns.practiceId],
    references: [practices.id],
  }),
  patient: one(patients, {
    fields: [vitalSigns.patientId],
    references: [patients.id],
  }),
  appointment: one(appointments, {
    fields: [vitalSigns.appointmentId],
    references: [appointments.id],
  }),
  recorder: one(users, {
    fields: [vitalSigns.recordedBy],
    references: [users.id],
  }),
}));

export const casesRelations = relations(cases, ({ one, many }) => ({
  practice: one(practices, {
    fields: [cases.practiceId],
    references: [practices.id],
  }),
  patient: one(patients, {
    fields: [cases.patientId],
    references: [patients.id],
  }),
  primaryVet: one(users, {
    fields: [cases.primaryVetId],
    references: [users.id],
  }),
  entries: many(caseEntries),
}));

export const caseEntriesRelations = relations(caseEntries, ({ one }) => ({
  case: one(cases, {
    fields: [caseEntries.caseId],
    references: [cases.id],
  }),
  appointment: one(appointments, {
    fields: [caseEntries.appointmentId],
    references: [appointments.id],
  }),
}));

export const treatmentPlansRelations = relations(
  treatmentPlans,
  ({ one, many }) => ({
    practice: one(practices, {
      fields: [treatmentPlans.practiceId],
      references: [practices.id],
    }),
    patient: one(patients, {
      fields: [treatmentPlans.patientId],
      references: [patients.id],
    }),
    problem: one(problemList, {
      fields: [treatmentPlans.problemId],
      references: [problemList.id],
    }),
    createdByUser: one(users, {
      fields: [treatmentPlans.createdBy],
      references: [users.id],
    }),
    items: many(treatmentPlanItems),
  }),
);

export const treatmentPlanItemsRelations = relations(
  treatmentPlanItems,
  ({ one }) => ({
    plan: one(treatmentPlans, {
      fields: [treatmentPlanItems.planId],
      references: [treatmentPlans.id],
    }),
  }),
);
