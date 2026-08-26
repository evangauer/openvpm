import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { baseColumns } from "./common";
import { practices } from "./practices";
import { appointments } from "./scheduling";
import { users } from "./users";
import { invoices } from "./billing";

export const visitCloseoutStatusEnum = pgEnum("visit_closeout_status", [
  "draft",
  "clinical_finalized",
  "completed",
]);

export const visitChargeDispositionEnum = pgEnum("visit_charge_disposition", [
  "paid",
  "accounts_receivable",
  "no_charge",
]);

export const visitPrescriptionDispositionEnum = pgEnum(
  "visit_prescription_disposition",
  ["prescribed", "not_needed"],
);

export const visitFollowUpDispositionEnum = pgEnum(
  "visit_follow_up_disposition",
  ["none", "needed", "scheduled"],
);

export const visitHandoffMethodEnum = pgEnum("visit_handoff_method", [
  "print",
  "verbal",
  "declined",
]);

export const visitFollowUpResolutionEnum = pgEnum(
  "visit_follow_up_resolution",
  ["scheduled", "completed", "not_needed"],
);

export type VisitMedicationSnapshot = {
  prescriptionId: string;
  medicationName: string;
  dosage: string;
  frequency: string;
  instructions: string | null;
  quantity: number | null;
};

export type VisitCloseoutAmendment = {
  priorRevision: number;
  reason: string;
  reopenedAt: string;
  reopenedBy: string;
  reopenedByName: string;
  clinicalFinalizedAt: string;
  clinicalFinalizedBy: string;
  clinicalFinalizerName: string;
  diagnosisSummary: string | null;
  dischargeInstructions: string | null;
  warningSigns: string | null;
  noInstructionsReason: string | null;
  prescriptionDisposition: "prescribed" | "not_needed";
  medicationSnapshot: VisitMedicationSnapshot[];
  followUpDisposition: "none" | "needed" | "scheduled";
  followUpNotes: string | null;
  followUpAppointmentId: string | null;
  followUpScheduledAt: string | null;
  followUpDueDate: string | null;
  followUpAssignedTo: string | null;
  followUpAssigneeName: string | null;
  followUpResolution: "scheduled" | "completed" | "not_needed" | null;
  followUpResolutionAppointmentId: string | null;
  followUpResolutionScheduledAt: string | null;
  followUpResolutionNotes: string | null;
  followUpResolvedAt: string | null;
  followUpResolvedBy: string | null;
  followUpResolverName: string | null;
  documentationExceptionReason: string | null;
};

/**
 * Editable replacement content for an attributed amendment. The currently
 * finalized clinical fields and their medication/follow-up snapshots remain on
 * the closeout row until this draft is validated and promoted atomically.
 */
export type VisitCloseoutAmendmentDraft = {
  baseRevision: number;
  reason: string;
  reopenedAt: string;
  reopenedBy: string;
  reopenedByName: string;
  diagnosisSummary: string | null;
  dischargeInstructions: string | null;
  warningSigns: string | null;
  noInstructionsReason: string | null;
  prescriptionDisposition: "prescribed" | "not_needed" | null;
  followUpDisposition: "none" | "needed" | "scheduled" | null;
  followUpNotes: string | null;
  followUpAppointmentId: string | null;
  followUpDueDate: string | null;
  followUpAssignedTo: string | null;
  documentationExceptionReason: string | null;
};

/**
 * Durable, attributable closeout state for a clinic visit. Clinical content is
 * finalized first; operational checkout then verifies billing and owner
 * handoff before changing the appointment to the terminal checked_out state.
 */
export const visitCloseouts = pgTable(
  "visit_closeouts",
  {
    ...baseColumns(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id),
    status: visitCloseoutStatusEnum("status").notNull().default("draft"),
    diagnosisSummary: text("diagnosis_summary"),
    dischargeInstructions: text("discharge_instructions"),
    warningSigns: text("warning_signs"),
    noInstructionsReason: text("no_instructions_reason"),
    prescriptionDisposition: visitPrescriptionDispositionEnum(
      "prescription_disposition",
    ),
    followUpDisposition: visitFollowUpDispositionEnum("follow_up_disposition"),
    followUpNotes: text("follow_up_notes"),
    followUpAppointmentId: uuid("follow_up_appointment_id").references(
      () => appointments.id,
    ),
    followUpScheduledAt: timestamp("follow_up_scheduled_at", {
      withTimezone: true,
    }),
    followUpDueDate: date("follow_up_due_date"),
    followUpAssignedTo: uuid("follow_up_assigned_to").references(
      () => users.id,
    ),
    followUpAssigneeName: text("follow_up_assignee_name"),
    followUpResolution: visitFollowUpResolutionEnum("follow_up_resolution"),
    followUpResolutionAppointmentId: uuid(
      "follow_up_resolution_appointment_id",
    ),
    followUpResolutionScheduledAt: timestamp(
      "follow_up_resolution_scheduled_at",
      { withTimezone: true },
    ),
    followUpResolutionNotes: text("follow_up_resolution_notes"),
    followUpResolvedAt: timestamp("follow_up_resolved_at", {
      withTimezone: true,
    }),
    followUpResolvedBy: uuid("follow_up_resolved_by").references(
      () => users.id,
    ),
    followUpResolverName: text("follow_up_resolver_name"),
    medicationSnapshot: jsonb("medication_snapshot")
      .$type<VisitMedicationSnapshot[]>()
      .notNull()
      .default([]),
    amendmentHistory: jsonb("amendment_history")
      .$type<VisitCloseoutAmendment[]>()
      .notNull()
      .default([]),
    amendmentDraft: jsonb(
      "amendment_draft",
    ).$type<VisitCloseoutAmendmentDraft | null>(),
    documentationExceptionReason: text("documentation_exception_reason"),
    clinicalFinalizedAt: timestamp("clinical_finalized_at", {
      withTimezone: true,
    }),
    clinicalFinalizedBy: uuid("clinical_finalized_by").references(
      () => users.id,
    ),
    clinicalFinalizerName: text("clinical_finalizer_name"),
    chargeDisposition: visitChargeDispositionEnum("charge_disposition"),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    noChargeReason: text("no_charge_reason"),
    handoffMethod: visitHandoffMethodEnum("handoff_method"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => users.id),
    revision: integer("revision").notNull().default(1),
  },
  (table) => ({
    appointmentUq: uniqueIndex("visit_closeouts_appointment_uq").on(
      table.appointmentId,
    ),
    practiceStatusIdx: index("visit_closeouts_practice_status_idx").on(
      table.practiceId,
      table.status,
      table.updatedAt,
    ),
    pendingFollowUpIdx: index("visit_closeouts_pending_follow_up_idx").on(
      table.practiceId,
      table.followUpDisposition,
      table.followUpResolvedAt,
      table.followUpDueDate,
    ),
    resolutionAppointmentFk: foreignKey({
      columns: [table.followUpResolutionAppointmentId],
      foreignColumns: [appointments.id],
      name: "visit_closeouts_resolution_appointment_fk",
    }),
    revisionCheck: check(
      "visit_closeouts_revision_check",
      sql`${table.revision} >= 1`,
    ),
    amendmentDraftCheck: check(
      "visit_closeouts_amendment_draft_check",
      sql`(${table.status} = 'draft' and ${table.amendmentDraft} is null)
        or (
          ${table.status} in ('clinical_finalized', 'completed')
          and (
            ${table.amendmentDraft} is null
            or jsonb_typeof(${table.amendmentDraft}) = 'object'
          )
        )`,
    ),
    clinicalStateCheck: check(
      "visit_closeouts_clinical_state_check",
      sql`${table.status} = 'draft'
        or (
          ${table.clinicalFinalizedAt} is not null
          and ${table.clinicalFinalizedBy} is not null
          and length(btrim(coalesce(${table.clinicalFinalizerName}, ''))) > 0
          and ${table.prescriptionDisposition} is not null
          and (
            ${table.prescriptionDisposition} = 'prescribed'
            and jsonb_array_length(${table.medicationSnapshot}) > 0
            or ${table.prescriptionDisposition} = 'not_needed'
            and jsonb_array_length(${table.medicationSnapshot}) = 0
          )
          and (
            length(btrim(coalesce(${table.dischargeInstructions}, ''))) > 0
            or length(btrim(coalesce(${table.noInstructionsReason}, ''))) > 0
          )
          and ${table.followUpDisposition} is not null
          and (
            ${table.followUpDisposition} = 'none'
            and ${table.followUpAppointmentId} is null
            and ${table.followUpScheduledAt} is null
            and ${table.followUpDueDate} is null
            and ${table.followUpAssignedTo} is null
            and ${table.followUpAssigneeName} is null
            or (
              ${table.followUpDisposition} = 'scheduled'
              and ${table.followUpAppointmentId} is not null
              and ${table.followUpScheduledAt} is not null
              and ${table.followUpDueDate} is null
              and ${table.followUpAssignedTo} is null
              and ${table.followUpAssigneeName} is null
            )
            or (
              ${table.followUpDisposition} = 'needed'
              and ${table.followUpAppointmentId} is null
              and ${table.followUpScheduledAt} is null
              and ${table.followUpDueDate} is not null
              and ${table.followUpAssignedTo} is not null
              and length(btrim(coalesce(${table.followUpAssigneeName}, ''))) > 0
            )
          )
        )`,
    ),
    completedStateCheck: check(
      "visit_closeouts_completed_state_check",
      sql`${table.status} <> 'completed'
        or (
          ${table.completedAt} is not null
          and ${table.completedBy} is not null
          and ${table.chargeDisposition} is not null
          and ${table.handoffMethod} is not null
          and (
            ${table.chargeDisposition} = 'no_charge'
            and length(btrim(coalesce(${table.noChargeReason}, ''))) > 0
            or ${table.chargeDisposition} in ('paid', 'accounts_receivable')
            and ${table.invoiceId} is not null
          )
        )`,
    ),
    followUpResolutionCheck: check(
      "visit_closeouts_follow_up_resolution_check",
      sql`${table.followUpResolvedAt} is null
        and ${table.followUpResolution} is null
        and ${table.followUpResolutionAppointmentId} is null
        and ${table.followUpResolutionScheduledAt} is null
        and ${table.followUpResolutionNotes} is null
        and ${table.followUpResolvedBy} is null
        and ${table.followUpResolverName} is null
        or (
          ${table.followUpDisposition} = 'needed'
          and ${table.followUpResolvedAt} is not null
          and ${table.followUpResolution} is not null
          and ${table.followUpResolvedBy} is not null
          and length(btrim(coalesce(${table.followUpResolverName}, ''))) > 0
          and (
            ${table.followUpResolution} = 'scheduled'
            and ${table.followUpResolutionAppointmentId} is not null
            and ${table.followUpResolutionScheduledAt} is not null
            or ${table.followUpResolution} in ('completed', 'not_needed')
            and ${table.followUpResolutionAppointmentId} is null
            and ${table.followUpResolutionScheduledAt} is null
            and length(btrim(coalesce(${table.followUpResolutionNotes}, ''))) > 0
          )
        )`,
    ),
  }),
);

export const visitCloseoutsRelations = relations(visitCloseouts, ({ one }) => ({
  practice: one(practices, {
    fields: [visitCloseouts.practiceId],
    references: [practices.id],
  }),
  appointment: one(appointments, {
    relationName: "closedAppointment",
    fields: [visitCloseouts.appointmentId],
    references: [appointments.id],
  }),
  followUpAppointment: one(appointments, {
    relationName: "followUpAppointment",
    fields: [visitCloseouts.followUpAppointmentId],
    references: [appointments.id],
  }),
  followUpResolutionAppointment: one(appointments, {
    relationName: "followUpResolutionAppointment",
    fields: [visitCloseouts.followUpResolutionAppointmentId],
    references: [appointments.id],
  }),
  invoice: one(invoices, {
    fields: [visitCloseouts.invoiceId],
    references: [invoices.id],
  }),
  clinicalFinalizer: one(users, {
    relationName: "clinicalFinalizer",
    fields: [visitCloseouts.clinicalFinalizedBy],
    references: [users.id],
  }),
  followUpAssignee: one(users, {
    relationName: "followUpAssignee",
    fields: [visitCloseouts.followUpAssignedTo],
    references: [users.id],
  }),
  followUpResolver: one(users, {
    relationName: "followUpResolver",
    fields: [visitCloseouts.followUpResolvedBy],
    references: [users.id],
  }),
  completer: one(users, {
    relationName: "visitCompleter",
    fields: [visitCloseouts.completedBy],
    references: [users.id],
  }),
}));
