import { sql } from "drizzle-orm";
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
  varchar,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";
import { users } from "./users";
import { visitCloseouts } from "./visit-closeouts";

export const clinicPilotStageEnum = pgEnum("clinic_pilot_stage", [
  "candidate",
  "parallel_setup",
  "visit_validation",
  "pilot_week",
  "graduation_review",
  "completed",
  "closed",
]);

export const clinicPilotDecisionEnum = pgEnum("clinic_pilot_decision", [
  "pending",
  "eligible",
  "approved",
  "paused",
  "not_a_fit",
  "graduated",
]);

export const clinicPilotWorkflowEnum = pgEnum("clinic_pilot_workflow", [
  "general_practice",
  "house_call",
]);

export const clinicPilotSupportCadenceEnum = pgEnum(
  "clinic_pilot_support_cadence",
  ["daily", "twice_weekly", "weekly"],
);

export const clinicPilotContactOutcomeEnum = pgEnum(
  "clinic_pilot_contact_outcome",
  ["replied", "no_reply", "scheduled", "completed", "declined"],
);

export const clinicPilotCommunicationModeEnum = pgEnum(
  "clinic_pilot_communication_mode",
  ["email_only", "email_and_sms"],
);

export const clinicPilotNextActionEnum = pgEnum("clinic_pilot_next_action", [
  "confirm_fit",
  "schedule_setup",
  "validate_import",
  "complete_first_visit",
  "review_communications",
  "configure_payment",
  "review_clinic_week",
  "resolve_blockers",
  "decide_graduation",
  "support_retention",
  "revisit_fit",
]);

export const clinicPilotReasonEnum = pgEnum("clinic_pilot_reason", [
  "initial_review",
  "clinic_feedback",
  "product_evidence",
  "support_review",
  "blocker_review",
  "graduation_decision",
]);

export const clinicPilotEventTypeEnum = pgEnum("clinic_pilot_event_type", [
  "enrolled",
  "updated",
]);

export type ClinicPilotQualificationChecklist = {
  supportedClinicType: boolean;
  supportedJurisdictionConfirmed: boolean;
  singleLocation: boolean;
  connectedModeAccepted: boolean;
  parallelRunAccepted: boolean;
  championConfirmed: boolean;
  supportedWorkflowConfirmed: boolean;
  noUnsupportedMustHave: boolean;
};

export type ClinicPilotEvidenceSnapshot = {
  verifiedAdminUserIds: string[];
  activeLocationIds: string[];
  setupCompletedAt: string | null;
  activatedEvidenceKey: string | null;
  activatedAt: string | null;
  firstVisitCloseoutId: string | null;
  firstVisitCompletedAt: string | null;
  clinicUseDays: Array<{
    closeoutId: string;
    completedAt: string;
    localDate: string;
  }>;
  paymentMethodEvidenceKey: string | null;
  paymentMethodCollectedAt: string | null;
  firstPositivePaymentEvidenceKey: string | null;
  firstPositivePaymentAt: string | null;
  billingStatus: string;
  subscriptionTier: string;
  trialEndsAt: string | null;
  hostedFullAccess: boolean;
  country: string;
  jurisdictionConfirmed: boolean;
  smsStatus: string;
};

export type ClinicPilotReadinessChecklist = {
  rolesAndDevicesValidated: boolean;
  migrationPlanAccepted: boolean;
  sampleValidationAccepted: boolean;
  firstVisitScheduled: boolean;
  exportAndRollbackConfirmed: boolean;
  supportCadenceConfirmed: boolean;
};

export const emptyClinicPilotQualification: ClinicPilotQualificationChecklist =
  {
    supportedClinicType: false,
    supportedJurisdictionConfirmed: false,
    singleLocation: false,
    connectedModeAccepted: false,
    parallelRunAccepted: false,
    championConfirmed: false,
    supportedWorkflowConfirmed: false,
    noUnsupportedMustHave: false,
  };

export const emptyClinicPilotReadiness: ClinicPilotReadinessChecklist = {
  rolesAndDevicesValidated: false,
  migrationPlanAccepted: false,
  sampleValidationAccepted: false,
  firstVisitScheduled: false,
  exportAndRollbackConfirmed: false,
  supportCadenceConfirmed: false,
};

/**
 * Current operator-owned projection for a controlled clinic pilot.
 *
 * This deliberately stores no free-form notes or duplicated clinic contact
 * details. Product progress remains authoritative in its source tables; this
 * row records only bounded operating decisions and the next review cadence.
 */
export const clinicPilots = pgTable(
  "clinic_pilots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    cohortKey: varchar("cohort_key", { length: 32 }).notNull(),
    workflow: clinicPilotWorkflowEnum("workflow").notNull(),
    stage: clinicPilotStageEnum("stage").notNull().default("candidate"),
    decision: clinicPilotDecisionEnum("decision").notNull().default("pending"),
    qualificationChecklist: jsonb("qualification_checklist")
      .$type<ClinicPilotQualificationChecklist>()
      .notNull()
      .default(emptyClinicPilotQualification),
    readinessChecklist: jsonb("readiness_checklist")
      .$type<ClinicPilotReadinessChecklist>()
      .notNull()
      .default(emptyClinicPilotReadiness),
    blockerCodes: text("blocker_codes")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    nextAction: clinicPilotNextActionEnum("next_action")
      .notNull()
      .default("confirm_fit"),
    supportCadence: clinicPilotSupportCadenceEnum("support_cadence")
      .notNull()
      .default("daily"),
    ownerIdentity: varchar("owner_identity", { length: 255 }).notNull(),
    communicationMode: clinicPilotCommunicationModeEnum("communication_mode")
      .notNull()
      .default("email_only"),
    communicationTestedAt: timestamp("communication_tested_at", {
      withTimezone: true,
    }),
    firstVisitValidatedAt: timestamp("first_visit_validated_at", {
      withTimezone: true,
    }),
    firstVisitValidatedCloseoutId: uuid(
      "first_visit_validated_closeout_id",
    ).references(() => visitCloseouts.id),
    clinicUseValidatedAt: timestamp("clinic_use_validated_at", {
      withTimezone: true,
    }),
    clinicUseValidatedHash: varchar("clinic_use_validated_hash", {
      length: 64,
    }),
    clinicAcceptanceAt: timestamp("clinic_acceptance_at", {
      withTimezone: true,
    }),
    clinicAcceptanceByUserId: uuid("clinic_acceptance_by_user_id"),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    lastContactOutcome: clinicPilotContactOutcomeEnum("last_contact_outcome"),
    targetStartOn: date("target_start_on"),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    practiceUq: uniqueIndex("clinic_pilots_practice_uq").on(table.practiceId),
    pilotPracticeUq: uniqueIndex("clinic_pilots_id_practice_uq").on(
      table.id,
      table.practiceId,
    ),
    reviewIdx: index("clinic_pilots_review_idx").on(
      table.stage,
      table.nextReviewAt,
      table.practiceId,
    ),
    acceptanceTenantFk: foreignKey({
      columns: [table.practiceId, table.clinicAcceptanceByUserId],
      foreignColumns: [users.practiceId, users.id],
      name: "clinic_pilots_acceptance_user_practice_fk",
    }),
    versionCheck: check(
      "clinic_pilots_version_check",
      sql`${table.version} > 0`,
    ),
    operatingShapeCheck: check(
      "clinic_pilots_operating_shape_check",
      sql`${table.cohortKey} ~ '^pilot-[0-9]{4}-[0-9]{2}$'
        and jsonb_typeof(${table.qualificationChecklist}) = 'object'
        and jsonb_typeof(${table.readinessChecklist}) = 'object'
        and ${table.ownerIdentity} = btrim(${table.ownerIdentity})
        and length(${table.ownerIdentity}) between 3 and 255
        and (${table.lastContactAt} is null) = (${table.lastContactOutcome} is null)
        and (${table.clinicAcceptanceAt} is null) = (${table.clinicAcceptanceByUserId} is null)
        and (${table.firstVisitValidatedAt} is null) = (${table.firstVisitValidatedCloseoutId} is null)
        and (${table.clinicUseValidatedAt} is null) = (${table.clinicUseValidatedHash} is null)
        and (${table.clinicUseValidatedHash} is null or ${table.clinicUseValidatedHash} ~ '^[a-f0-9]{64}$')`,
    ),
    blockerCodesCheck: check(
      "clinic_pilots_blocker_codes_check",
      sql`${table.blockerCodes} <@ ARRAY[
          'workflow_fit',
          'data_import',
          'staff_training',
          'record_accuracy',
          'billing',
          'payments',
          'email',
          'sms',
          'permissions',
          'device_connectivity',
          'backup_export',
          'support_coverage'
        ]::text[]
        and cardinality(${table.blockerCodes}) <= 12
        and array_position(${table.blockerCodes}, null) is null`,
    ),
    lifecycleCheck: check(
      "clinic_pilots_lifecycle_check",
      sql`(
          ${table.stage} = 'completed'
          and ${table.decision} = 'graduated'
          and cardinality(${table.blockerCodes}) = 0
          and ${table.nextAction} = 'support_retention'
          and ${table.nextReviewAt} is null
        ) or (
          ${table.stage} = 'closed'
          and ${table.decision} = 'not_a_fit'
          and ${table.nextAction} = 'revisit_fit'
          and ${table.nextReviewAt} is null
        ) or (
          ${table.stage} not in ('completed', 'closed')
          and ${table.decision} not in ('graduated', 'not_a_fit')
          and ${table.nextReviewAt} is not null
        )`,
    ),
  }),
);

/**
 * Immutable, PHI-free snapshots of every pilot projection change. The event
 * history is the audit trail; the current row above may be updated by an
 * authenticated platform operator under explicit system context.
 */
export const clinicPilotEvents = pgTable(
  "clinic_pilot_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicPilotId: uuid("clinic_pilot_id")
      .notNull()
      .references(() => clinicPilots.id),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    operationId: uuid("operation_id").notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    eventType: clinicPilotEventTypeEnum("event_type").notNull(),
    reason: clinicPilotReasonEnum("reason").notNull(),
    cohortKey: varchar("cohort_key", { length: 32 }).notNull(),
    workflow: clinicPilotWorkflowEnum("workflow").notNull(),
    stage: clinicPilotStageEnum("stage").notNull(),
    decision: clinicPilotDecisionEnum("decision").notNull(),
    qualificationChecklist: jsonb("qualification_checklist")
      .$type<ClinicPilotQualificationChecklist>()
      .notNull(),
    readinessChecklist: jsonb("readiness_checklist")
      .$type<ClinicPilotReadinessChecklist>()
      .notNull(),
    blockerCodes: text("blocker_codes").array().notNull(),
    nextAction: clinicPilotNextActionEnum("next_action").notNull(),
    supportCadence: clinicPilotSupportCadenceEnum("support_cadence").notNull(),
    ownerIdentity: varchar("owner_identity", { length: 255 }).notNull(),
    communicationMode:
      clinicPilotCommunicationModeEnum("communication_mode").notNull(),
    communicationTestedAt: timestamp("communication_tested_at", {
      withTimezone: true,
    }),
    firstVisitValidatedAt: timestamp("first_visit_validated_at", {
      withTimezone: true,
    }),
    firstVisitValidatedCloseoutId: uuid(
      "first_visit_validated_closeout_id",
    ).references(() => visitCloseouts.id),
    clinicUseValidatedAt: timestamp("clinic_use_validated_at", {
      withTimezone: true,
    }),
    clinicUseValidatedHash: varchar("clinic_use_validated_hash", {
      length: 64,
    }),
    clinicAcceptanceAt: timestamp("clinic_acceptance_at", {
      withTimezone: true,
    }),
    clinicAcceptanceByUserId: uuid("clinic_acceptance_by_user_id"),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    lastContactOutcome: clinicPilotContactOutcomeEnum("last_contact_outcome"),
    targetStartOn: date("target_start_on"),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    projectionVersion: integer("projection_version").notNull(),
    actorIdentity: varchar("actor_identity", { length: 255 }).notNull(),
    evidenceSnapshot: jsonb("evidence_snapshot")
      .$type<ClinicPilotEvidenceSnapshot>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    operationUq: uniqueIndex("clinic_pilot_events_operation_uq").on(
      table.operationId,
    ),
    historyIdx: index("clinic_pilot_events_history_idx").on(
      table.practiceId,
      table.createdAt,
      table.id,
    ),
    pilotTenantFk: foreignKey({
      columns: [table.clinicPilotId, table.practiceId],
      foreignColumns: [clinicPilots.id, clinicPilots.practiceId],
      name: "clinic_pilot_events_pilot_practice_fk",
    }),
    acceptanceTenantFk: foreignKey({
      columns: [table.practiceId, table.clinicAcceptanceByUserId],
      foreignColumns: [users.practiceId, users.id],
      name: "clinic_pilot_events_acceptance_user_practice_fk",
    }),
    snapshotCheck: check(
      "clinic_pilot_events_snapshot_check",
      sql`${table.projectionVersion} > 0
        and ${table.payloadHash} ~ '^[a-f0-9]{64}$'
        and ${table.actorIdentity} = btrim(${table.actorIdentity})
        and length(${table.actorIdentity}) between 3 and 255
        and ${table.ownerIdentity} = btrim(${table.ownerIdentity})
        and length(${table.ownerIdentity}) between 3 and 255
        and ${table.cohortKey} ~ '^pilot-[0-9]{4}-[0-9]{2}$'
        and jsonb_typeof(${table.qualificationChecklist}) = 'object'
        and jsonb_typeof(${table.readinessChecklist}) = 'object'
        and jsonb_typeof(${table.evidenceSnapshot}) = 'object'
        and (${table.lastContactAt} is null) = (${table.lastContactOutcome} is null)
        and (${table.clinicAcceptanceAt} is null) = (${table.clinicAcceptanceByUserId} is null)
        and (${table.firstVisitValidatedAt} is null) = (${table.firstVisitValidatedCloseoutId} is null)
        and (${table.clinicUseValidatedAt} is null) = (${table.clinicUseValidatedHash} is null)
        and (${table.clinicUseValidatedHash} is null or ${table.clinicUseValidatedHash} ~ '^[a-f0-9]{64}$')
        and ${table.blockerCodes} <@ ARRAY[
          'workflow_fit',
          'data_import',
          'staff_training',
          'record_accuracy',
          'billing',
          'payments',
          'email',
          'sms',
          'permissions',
          'device_connectivity',
          'backup_export',
          'support_coverage'
        ]::text[]
        and cardinality(${table.blockerCodes}) <= 12
        and array_position(${table.blockerCodes}, null) is null`,
    ),
  }),
);
