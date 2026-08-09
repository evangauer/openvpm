import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  labFollowUpStatusEnum,
  labResultFlagEnum,
  labResults,
  labStatusEnum,
} from "./clinical";
import { appointments } from "./scheduling";
import { patients } from "./patients";
import { practices } from "./practices";
import { users } from "./users";

export const labResultEventTypeEnum = pgEnum("lab_result_event_type", [
  "created",
  "completed",
  "reviewed",
  "follow_up_assigned",
  "follow_up_reassigned",
  "follow_up_completed",
]);

/**
 * Immutable clinical evidence for lab completion, review, and follow-up
 * ownership. `lab_results` remains the efficient current-state projection.
 */
export const labResultEvents = pgTable(
  "lab_result_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    labResultId: uuid("lab_result_id")
      .notNull()
      .references(() => labResults.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    eventType: labResultEventTypeEnum("event_type").notNull(),
    statusBefore: labStatusEnum("status_before"),
    statusAfter: labStatusEnum("status_after").notNull(),
    // Immutable snapshot of the clinical values visible for this transition.
    // The current-state row may evolve, so review evidence must stand alone.
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
    resultFlag: labResultFlagEnum("result_flag").notNull(),
    followUpStatus: labFollowUpStatusEnum("follow_up_status")
      .notNull()
      .default("not_required"),
    followUpAssignedTo: uuid("follow_up_assigned_to").references(
      () => users.id,
    ),
    followUpDueAt: timestamp("follow_up_due_at", { withTimezone: true }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    actorName: varchar("actor_name", { length: 255 }).notNull(),
    note: text("note"),
    operationId: uuid("operation_id").notNull(),
    operationPayloadHash: varchar("operation_payload_hash", {
      length: 64,
    }).notNull(),
  },
  (table) => ({
    resultHistoryIdx: index("lab_result_events_result_history_idx").on(
      table.practiceId,
      table.labResultId,
      table.createdAt,
      table.id,
    ),
    practiceTimeIdx: index("lab_result_events_practice_time_idx").on(
      table.practiceId,
      table.createdAt,
      table.id,
    ),
    operationUq: uniqueIndex("lab_result_events_practice_operation_uq").on(
      table.practiceId,
      table.operationId,
    ),
    createdUq: uniqueIndex("lab_result_events_created_uq")
      .on(table.practiceId, table.labResultId)
      .where(sql`${table.eventType} = 'created'`),
    resultTenantFk: foreignKey({
      columns: [table.practiceId, table.labResultId],
      foreignColumns: [labResults.practiceId, labResults.id],
      name: "lab_result_events_result_tenant_fk",
    }),
    patientTenantFk: foreignKey({
      columns: [table.practiceId, table.patientId],
      foreignColumns: [patients.practiceId, patients.id],
      name: "lab_result_events_patient_tenant_fk",
    }),
    appointmentTenantFk: foreignKey({
      columns: [table.practiceId, table.appointmentId, table.patientId],
      foreignColumns: [
        appointments.practiceId,
        appointments.id,
        appointments.patientId,
      ],
      name: "lab_result_events_appointment_tenant_fk",
    }),
    actorTenantFk: foreignKey({
      columns: [table.practiceId, table.actorId],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_result_events_actor_tenant_fk",
    }),
    assigneeTenantFk: foreignKey({
      columns: [table.practiceId, table.followUpAssignedTo],
      foreignColumns: [users.practiceId, users.id],
      name: "lab_result_events_assignee_tenant_fk",
    }),
    shapeCheck: check(
      "lab_result_events_shape_check",
      sql`length(btrim(${table.actorName})) between 1 and 255
        and ${table.operationPayloadHash} ~ '^[0-9a-f]{64}$'
        and (${table.note} is null or length(${table.note}) <= 1000)
        and (${table.statusAfter} <> 'pending' or ${table.followUpStatus} = 'not_required')
        and not (
          ${table.statusAfter} = 'reviewed'
          and ${table.resultFlag} = 'critical'
          and ${table.followUpStatus} = 'not_required'
        )
        and not (
          ${table.resultFlag} = 'critical'
          and ${table.followUpStatus} in ('open', 'completed')
          and ${table.followUpDueAt} is null
        )
        and (
          (${table.statusAfter} = 'pending'
            and ${table.resultValue} is null
            and ${table.unit} is null
            and ${table.referenceRangeLow} is null
            and ${table.referenceRangeHigh} is null
            and ${table.resultFlag} = 'unknown')
          or (${table.statusAfter} in ('completed', 'reviewed')
            and length(btrim(coalesce(${table.resultValue}, ''))) between 1 and 128)
        )
        and (
          (${table.followUpStatus} = 'not_required'
            and ${table.followUpAssignedTo} is null
            and ${table.followUpDueAt} is null)
          or (${table.followUpStatus} in ('open', 'completed')
            and ${table.followUpAssignedTo} is not null)
        )
        and (
          ${table.eventType} = 'created'
          and ${table.statusBefore} is null
          and ${table.statusAfter} in ('pending', 'completed')
          and (${table.statusAfter} <> 'pending' or ${table.resultFlag} = 'unknown')
        or ${table.eventType} = 'completed'
          and ${table.statusBefore} = 'pending'
          and ${table.statusAfter} = 'completed'
        or ${table.eventType} = 'reviewed'
          and ${table.statusBefore} = 'completed'
          and ${table.statusAfter} = 'reviewed'
        or ${table.eventType} in ('follow_up_assigned', 'follow_up_reassigned')
          and ${table.statusBefore} = ${table.statusAfter}
          and ${table.followUpStatus} = 'open'
          and ${table.followUpAssignedTo} is not null
        or ${table.eventType} = 'follow_up_completed'
          and ${table.statusBefore} = ${table.statusAfter}
          and ${table.followUpStatus} = 'completed'
          and ${table.followUpAssignedTo} is not null
          and length(btrim(coalesce(${table.note}, ''))) between 3 and 1000
        )`,
    ),
  }),
);

export const labResultEventsRelations = relations(
  labResultEvents,
  ({ one }) => ({
    result: one(labResults, {
      fields: [labResultEvents.labResultId],
      references: [labResults.id],
    }),
    patient: one(patients, {
      fields: [labResultEvents.patientId],
      references: [patients.id],
    }),
    appointment: one(appointments, {
      fields: [labResultEvents.appointmentId],
      references: [appointments.id],
    }),
    actor: one(users, {
      fields: [labResultEvents.actorId],
      references: [users.id],
    }),
  }),
);
