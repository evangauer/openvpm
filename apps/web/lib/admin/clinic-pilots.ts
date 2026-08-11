import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import {
  clinicPilotEvents,
  clinicPilots,
  type ClinicPilotEvidenceSnapshot,
  type ClinicPilotQualificationChecklist,
  type ClinicPilotReadinessChecklist,
} from "@openpims/db";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { recoverySetupState } from "@/lib/admin/activation-recovery";
import { hasHostedFullAccess } from "@/lib/billing/plans";
import { withSystem } from "@/lib/tenant-db";
import { hasExplicitPracticeJurisdiction } from "@/lib/locale/clinic-regions";

export const CLINIC_PILOT_WORKFLOWS = [
  "general_practice",
  "house_call",
] as const;
export const CLINIC_PILOT_STAGES = [
  "candidate",
  "parallel_setup",
  "visit_validation",
  "pilot_week",
  "graduation_review",
  "completed",
  "closed",
] as const;
export const CLINIC_PILOT_DECISIONS = [
  "pending",
  "eligible",
  "approved",
  "paused",
  "not_a_fit",
  "graduated",
] as const;
export const CLINIC_PILOT_BLOCKERS = [
  "workflow_fit",
  "data_import",
  "staff_training",
  "record_accuracy",
  "billing",
  "payments",
  "email",
  "sms",
  "permissions",
  "device_connectivity",
  "backup_export",
  "support_coverage",
] as const;
export const CLINIC_PILOT_NEXT_ACTIONS = [
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
] as const;
export const CLINIC_PILOT_SUPPORT_CADENCES = [
  "daily",
  "twice_weekly",
  "weekly",
] as const;
export const CLINIC_PILOT_CONTACT_OUTCOMES = [
  "replied",
  "no_reply",
  "scheduled",
  "completed",
  "declined",
] as const;
export const CLINIC_PILOT_COMMUNICATION_MODES = [
  "email_only",
  "email_and_sms",
] as const;
export const CLINIC_PILOT_REASONS = [
  "initial_review",
  "clinic_feedback",
  "product_evidence",
  "support_review",
  "blocker_review",
  "graduation_decision",
] as const;

export const CLINIC_PILOT_QUALIFICATION_KEYS = [
  "supportedClinicType",
  "supportedJurisdictionConfirmed",
  "singleLocation",
  "connectedModeAccepted",
  "parallelRunAccepted",
  "championConfirmed",
  "supportedWorkflowConfirmed",
  "noUnsupportedMustHave",
] as const satisfies readonly (keyof ClinicPilotQualificationChecklist)[];

export const CLINIC_PILOT_READINESS_KEYS = [
  "rolesAndDevicesValidated",
  "migrationPlanAccepted",
  "sampleValidationAccepted",
  "firstVisitScheduled",
  "exportAndRollbackConfirmed",
  "supportCadenceConfirmed",
] as const satisfies readonly (keyof ClinicPilotReadinessChecklist)[];

export type ClinicPilotWorkflow = (typeof CLINIC_PILOT_WORKFLOWS)[number];
export type ClinicPilotStage = (typeof CLINIC_PILOT_STAGES)[number];
export type ClinicPilotDecision = (typeof CLINIC_PILOT_DECISIONS)[number];
export type ClinicPilotBlocker = (typeof CLINIC_PILOT_BLOCKERS)[number];
export type ClinicPilotNextAction = (typeof CLINIC_PILOT_NEXT_ACTIONS)[number];
export type ClinicPilotSupportCadence =
  (typeof CLINIC_PILOT_SUPPORT_CADENCES)[number];
export type ClinicPilotContactOutcome =
  (typeof CLINIC_PILOT_CONTACT_OUTCOMES)[number];
export type ClinicPilotCommunicationMode =
  (typeof CLINIC_PILOT_COMMUNICATION_MODES)[number];
export type ClinicPilotReason = (typeof CLINIC_PILOT_REASONS)[number];

export type ClinicPilotSmsStatus =
  | "not_configured"
  | "pending"
  | "action_required"
  | "carrier_approved_sending_off"
  | "ready";

export interface ClinicPilotEvidence {
  verifiedAdmin: boolean;
  verifiedAdmins: Array<{ id: string; name: string; email: string }>;
  verifiedAdminUserIds: string[];
  activeLocationCount: number;
  activeLocationIds: string[];
  setupComplete: boolean;
  setupCompletedAt: Date | null;
  activatedEvidenceKey: string | null;
  activatedAt: Date | null;
  firstVisitCloseoutId: string | null;
  firstVisitCompletedAt: Date | null;
  distinctClinicDays: number;
  clinicUseDays: Array<{
    closeoutId: string;
    completedAt: string;
    localDate: string;
  }>;
  paymentMethodEvidenceKey: string | null;
  paymentMethodCollectedAt: Date | null;
  firstPositivePaymentEvidenceKey: string | null;
  firstPositivePaymentAt: Date | null;
  billingStatus: string;
  subscriptionTier: string;
  trialEndsAt: Date | null;
  hostedFullAccess: boolean;
  country: string;
  jurisdictionConfirmed: boolean;
  smsStatus: ClinicPilotSmsStatus;
}

export interface SaveClinicPilotInput {
  practiceId: string;
  operationId: string;
  expectedVersion: number | null;
  cohortKey: string;
  workflow: ClinicPilotWorkflow;
  stage: ClinicPilotStage;
  decision: ClinicPilotDecision;
  qualificationChecklist: ClinicPilotQualificationChecklist;
  readinessChecklist: ClinicPilotReadinessChecklist;
  blockerCodes: ClinicPilotBlocker[];
  nextAction: ClinicPilotNextAction;
  supportCadence: ClinicPilotSupportCadence;
  communicationMode: ClinicPilotCommunicationMode;
  communicationTested: boolean;
  firstVisitValidated: boolean;
  clinicUseValidated: boolean;
  clinicAcceptanceConfirmed: boolean;
  clinicAcceptanceByUserId: string | null;
  lastContactAt: string | null;
  lastContactOutcome: ClinicPilotContactOutcome | null;
  targetStartOn: string | null;
  nextReviewAt: string | null;
  reason: ClinicPilotReason;
}

export class ClinicPilotConflictError extends Error {}
export class ClinicPilotEligibilityError extends Error {}
export class ClinicPilotNotFoundError extends Error {}

interface ClinicPilotQueueRow {
  id: string;
  practiceId: string;
  practiceName: string;
  cohortKey: string;
  workflow: ClinicPilotWorkflow;
  stage: ClinicPilotStage;
  decision: ClinicPilotDecision;
  qualificationChecklist: ClinicPilotQualificationChecklist;
  readinessChecklist: ClinicPilotReadinessChecklist;
  blockerCodes: ClinicPilotBlocker[];
  nextAction: ClinicPilotNextAction;
  supportCadence: ClinicPilotSupportCadence;
  ownerIdentity: string;
  communicationMode: ClinicPilotCommunicationMode;
  communicationTestedAt: Date | string | null;
  firstVisitValidatedAt: Date | string | null;
  firstVisitValidatedCloseoutId: string | null;
  clinicUseValidatedAt: Date | string | null;
  clinicUseValidatedHash: string | null;
  clinicAcceptanceAt: Date | string | null;
  clinicAcceptanceByUserId: string | null;
  lastContactAt: Date | string | null;
  lastContactOutcome: ClinicPilotContactOutcome | null;
  targetStartOn: string | null;
  nextReviewAt: Date | string | null;
  version: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  billingStatus: string;
  subscriptionTier: string;
  trialEndsAt: Date | string | null;
  country: string;
  settings: unknown;
  verifiedAdmins: Array<{ id: string; name: string; email: string }> | null;
  activeLocationIds: string[] | null;
  activeLocationCount: number | string;
  activatedEvidenceKey: string | null;
  activatedAt: Date | string | null;
  paymentMethodEvidenceKey: string | null;
  paymentMethodCollectedAt: Date | string | null;
  firstPositivePaymentEvidenceKey: string | null;
  firstPositivePaymentAt: Date | string | null;
  firstVisitCloseoutId: string | null;
  firstVisitCompletedAt: Date | string | null;
  distinctClinicDays: number | string;
  clinicUseDays: ClinicPilotEvidence["clinicUseDays"] | null;
  smsStatus: ClinicPilotSmsStatus;
  lastChangedAt: Date | string;
  lastChangedBy: string;
  lastChangeReason: ClinicPilotReason;
}

function asDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function checklistComplete<T extends object>(
  checklist: T,
  keys: readonly (keyof T)[],
): boolean {
  return keys.every((key) => checklist[key] === true);
}

export function clinicPilotGateIssues(
  input: Omit<
    SaveClinicPilotInput,
    "operationId" | "expectedVersion" | "reason"
  >,
  evidence: ClinicPilotEvidence,
  now: Date = new Date(),
): string[] {
  const issues: string[] = [];
  const qualificationComplete = checklistComplete(
    input.qualificationChecklist,
    CLINIC_PILOT_QUALIFICATION_KEYS,
  );
  const readinessComplete = checklistComplete(
    input.readinessChecklist,
    CLINIC_PILOT_READINESS_KEYS,
  );
  const needsApprovedReadiness = ["approved", "graduated"].includes(
    input.decision,
  );
  const allowedStates: Record<
    ClinicPilotStage,
    Partial<Record<ClinicPilotDecision, readonly ClinicPilotNextAction[]>>
  > = {
    candidate: { pending: ["confirm_fit", "resolve_blockers"] },
    parallel_setup: {
      eligible: ["schedule_setup", "validate_import"],
      paused: ["resolve_blockers"],
    },
    visit_validation: {
      approved: ["complete_first_visit", "review_communications"],
      paused: ["resolve_blockers"],
    },
    pilot_week: {
      approved: [
        "review_clinic_week",
        "review_communications",
        "configure_payment",
      ],
      paused: ["resolve_blockers"],
    },
    graduation_review: {
      approved: ["decide_graduation", "configure_payment"],
      paused: ["resolve_blockers"],
    },
    completed: { graduated: ["support_retention"] },
    closed: { not_a_fit: ["revisit_fit"] },
  };
  const allowedActions = allowedStates[input.stage][input.decision];
  if (!allowedActions?.includes(input.nextAction)) {
    issues.push(
      "Choose a stage, decision, and next action that belong together.",
    );
  }
  if (input.decision === "paused" && input.blockerCodes.length === 0) {
    issues.push("A paused pilot must identify at least one bounded blocker.");
  }

  if (
    ["eligible", "approved", "graduated"].includes(input.decision) &&
    !qualificationComplete
  ) {
    issues.push(
      "Complete every clinic-fit check before qualifying this pilot.",
    );
  }
  if (needsApprovedReadiness && !readinessComplete) {
    issues.push("Complete every launch-readiness check before approval.");
  }
  if (needsApprovedReadiness && !evidence.setupComplete) {
    issues.push("Complete guided clinic setup before approval.");
  }
  if (needsApprovedReadiness && evidence.country !== "US") {
    issues.push(
      "The first controlled clinic cohort is limited to the United States.",
    );
  }
  if (needsApprovedReadiness && !evidence.jurisdictionConfirmed) {
    issues.push(
      "The clinic must explicitly confirm its jurisdiction before approval.",
    );
  }
  if (needsApprovedReadiness && !evidence.verifiedAdmin) {
    issues.push("A verified clinic administrator is required.");
  }
  if (needsApprovedReadiness && evidence.activeLocationCount !== 1) {
    issues.push("The controlled pilot must have exactly one active location.");
  }
  if (
    input.blockerCodes.length > 0 &&
    input.stage !== "closed" &&
    input.nextAction !== "resolve_blockers"
  ) {
    issues.push("Open blockers require Resolve blockers as the next action.");
  }
  if (needsApprovedReadiness && input.blockerCodes.length > 0) {
    issues.push("Resolve every blocker before approving readiness.");
  }
  if (
    ["visit_validation", "pilot_week", "graduation_review"].includes(
      input.stage,
    ) &&
    !["approved", "paused"].includes(input.decision)
  ) {
    issues.push(
      "This stage requires an approved or paused readiness decision.",
    );
  }
  if (
    ["pilot_week", "graduation_review", "completed"].includes(input.stage) &&
    (!evidence.activatedAt ||
      !evidence.firstVisitCompletedAt ||
      !input.firstVisitValidated)
  ) {
    issues.push(
      "Complete activation and explicitly validate one real visit before the pilot week.",
    );
  }
  if (input.firstVisitValidated && !evidence.firstVisitCloseoutId) {
    issues.push("A real visit closeout must be observed before validating it.");
  }
  if (
    ["pilot_week", "graduation_review", "completed"].includes(input.stage) &&
    !input.communicationTested
  ) {
    issues.push(
      "Verify the selected client communication path before the pilot week.",
    );
  }
  if (
    ["pilot_week", "graduation_review", "completed"].includes(input.stage) &&
    input.communicationMode === "email_and_sms" &&
    evidence.smsStatus !== "ready"
  ) {
    issues.push(
      "SMS must be operational before it is included in the pilot workflow.",
    );
  }
  if (
    ["graduation_review", "completed"].includes(input.stage) &&
    evidence.distinctClinicDays < 5
  ) {
    issues.push(
      "Five distinct clinic-use days are required before graduation review.",
    );
  }
  if (
    ["graduation_review", "completed"].includes(input.stage) &&
    !input.clinicUseValidated
  ) {
    issues.push("Validate the five clinic-use days as real operating work.");
  }
  if (input.clinicUseValidated && evidence.distinctClinicDays < 5) {
    issues.push(
      "Five observed clinic-use days are required before validation.",
    );
  }
  if (input.decision === "graduated" && !evidence.paymentMethodCollectedAt) {
    issues.push("Collect a payment method before graduating the pilot.");
  }
  if (input.decision === "graduated" && !evidence.hostedFullAccess) {
    issues.push(
      "The clinic must have current hosted write access before graduation.",
    );
  }
  if (input.decision === "graduated") {
    if (!input.clinicAcceptanceConfirmed || !input.clinicAcceptanceByUserId) {
      issues.push(
        "Record explicit acceptance from a verified clinic administrator.",
      );
    } else if (
      !evidence.verifiedAdminUserIds.includes(input.clinicAcceptanceByUserId)
    ) {
      issues.push(
        "Clinic acceptance must be attributed to a current verified administrator.",
      );
    }
  }
  if (
    input.clinicAcceptanceConfirmed &&
    !["graduation_review", "completed"].includes(input.stage)
  ) {
    issues.push("Record clinic acceptance only after the five-day review.");
  }
  if ((input.stage === "completed") !== (input.decision === "graduated")) {
    issues.push(
      "Completed stage and graduated decision must be recorded together.",
    );
  }
  if ((input.stage === "closed") !== (input.decision === "not_a_fit")) {
    issues.push(
      "Closed stage and not-a-fit decision must be recorded together.",
    );
  }
  const isTerminal = ["completed", "closed"].includes(input.stage);
  if (isTerminal !== (input.nextReviewAt === null)) {
    issues.push(
      isTerminal
        ? "Clear the next review when closing a pilot."
        : "Schedule the next review before saving an active pilot.",
    );
  }
  if ((input.lastContactAt === null) !== (input.lastContactOutcome === null)) {
    issues.push("Record the contact time and outcome together.");
  }
  if (!isTerminal && input.nextReviewAt) {
    const reviewAt = new Date(input.nextReviewAt);
    const cadenceMs: Record<ClinicPilotSupportCadence, number> = {
      daily: 24 * 60 * 60 * 1000,
      twice_weekly: 4 * 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
    };
    if (reviewAt.getTime() <= now.getTime()) {
      issues.push("Schedule the next review in the future.");
    } else if (
      reviewAt.getTime() >
      now.getTime() + cadenceMs[input.supportCadence]
    ) {
      issues.push(
        "The next review cannot be later than the selected support cadence.",
      );
    }
  }
  return issues;
}

export function clinicPilotCohortKey(now: Date = new Date()): string {
  return `pilot-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function payloadHash(input: SaveClinicPilotInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        blockerCodes: [...new Set(input.blockerCodes)].sort(),
      }),
    )
    .digest("hex");
}

function evidenceSnapshot(
  evidence: ClinicPilotEvidence,
): ClinicPilotEvidenceSnapshot {
  return {
    verifiedAdminUserIds: evidence.verifiedAdminUserIds,
    activeLocationIds: evidence.activeLocationIds,
    setupCompletedAt: evidence.setupCompletedAt?.toISOString() ?? null,
    activatedEvidenceKey: evidence.activatedEvidenceKey,
    activatedAt: evidence.activatedAt?.toISOString() ?? null,
    firstVisitCloseoutId: evidence.firstVisitCloseoutId,
    firstVisitCompletedAt:
      evidence.firstVisitCompletedAt?.toISOString() ?? null,
    clinicUseDays: evidence.clinicUseDays,
    paymentMethodEvidenceKey: evidence.paymentMethodEvidenceKey,
    paymentMethodCollectedAt:
      evidence.paymentMethodCollectedAt?.toISOString() ?? null,
    firstPositivePaymentEvidenceKey: evidence.firstPositivePaymentEvidenceKey,
    firstPositivePaymentAt:
      evidence.firstPositivePaymentAt?.toISOString() ?? null,
    billingStatus: evidence.billingStatus,
    subscriptionTier: evidence.subscriptionTier,
    trialEndsAt: evidence.trialEndsAt?.toISOString() ?? null,
    hostedFullAccess: evidence.hostedFullAccess,
    country: evidence.country,
    jurisdictionConfirmed: evidence.jurisdictionConfirmed,
    smsStatus: evidence.smsStatus,
  };
}

function clinicUseEvidenceHash(evidence: ClinicPilotEvidence): string | null {
  if (evidence.clinicUseDays.length < 5) return null;
  return createHash("sha256")
    .update(JSON.stringify(evidence.clinicUseDays.slice(0, 5)))
    .digest("hex");
}

export async function loadClinicPilotQueue(db: Database) {
  return withSystem(db, async (tx) => {
    const result = await tx.execute(sql`
      with verified_admins as (
        select
          u.practice_id,
          jsonb_agg(
            jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)
            order by u.created_at, u.id
          ) as verified_admins
        from users u
        where u.role = 'admin'
          and u.deleted_at is null
          and u.email_verified_at is not null
        group by u.practice_id
      ), location_evidence as (
        select
          l.practice_id,
          count(*)::int as active_location_count,
          array_agg(l.id order by l.id) as active_location_ids
        from locations l
        where l.deleted_at is null
        group by l.practice_id
      ), milestone_evidence as (
        select
          pcm.practice_id,
          max(pcm.evidence_key) filter (
            where pcm.milestone = 'activated'
          ) as activated_evidence_key,
          min(pcm.occurred_at) filter (
            where pcm.milestone = 'activated'
          ) as activated_at,
          max(pcm.evidence_key) filter (
            where pcm.milestone = 'payment_method_collected'
          ) as payment_method_evidence_key,
          min(pcm.occurred_at) filter (
            where pcm.milestone = 'payment_method_collected'
          ) as payment_method_collected_at,
          max(pcm.evidence_key) filter (
            where pcm.milestone = 'first_positive_payment'
          ) as first_positive_payment_evidence_key,
          min(pcm.occurred_at) filter (
            where pcm.milestone = 'first_positive_payment'
          ) as first_positive_payment_at
        from practice_conversion_milestones pcm
        group by pcm.practice_id
      ), eligible_closeouts as (
        select
          vc.practice_id,
          vc.id as closeout_id,
          vc.completed_at,
          (vc.completed_at at time zone p.timezone)::date as local_date
        from visit_closeouts vc
        join appointments a
          on a.id = vc.appointment_id
         and a.practice_id = vc.practice_id
         and a.deleted_at is null
        join practices p
          on p.id = vc.practice_id
         and p.deleted_at is null
        join clinic_pilots pilot
          on pilot.practice_id = vc.practice_id
        where vc.status = 'completed'
          and vc.completed_at is not null
          and vc.completed_at >= pilot.created_at
          and vc.deleted_at is null
          and a.created_at >= p.created_at
          and not (
            coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
              @> to_jsonb(a.id::text)
          )
      ), clinic_use_days as (
        select distinct on (practice_id, local_date)
          practice_id, closeout_id, completed_at, local_date
        from eligible_closeouts
        order by practice_id, local_date, completed_at, closeout_id
      ), ranked_clinic_use_days as (
        select
          clinic_use_days.*,
          row_number() over (
            partition by practice_id order by completed_at, closeout_id
          ) as day_rank
        from clinic_use_days
      ), clinic_use as (
        select
          practice_id,
          (array_agg(closeout_id order by completed_at, closeout_id))[1]
            as first_visit_closeout_id,
          min(completed_at) as first_visit_completed_at,
          count(*)::int as distinct_clinic_days,
          jsonb_agg(
            jsonb_build_object(
              'closeoutId', closeout_id,
              'completedAt', completed_at,
              'localDate', local_date
            ) order by completed_at, closeout_id
          ) filter (where day_rank <= 5) as clinic_use_days
        from ranked_clinic_use_days
        group by practice_id
      )
      select
        cp.id,
        cp.practice_id as "practiceId",
        p.name as "practiceName",
        cp.cohort_key as "cohortKey",
        cp.workflow,
        cp.stage,
        cp.decision,
        cp.qualification_checklist as "qualificationChecklist",
        cp.readiness_checklist as "readinessChecklist",
        cp.blocker_codes as "blockerCodes",
        cp.next_action as "nextAction",
        cp.support_cadence as "supportCadence",
        cp.owner_identity as "ownerIdentity",
        cp.communication_mode as "communicationMode",
        cp.communication_tested_at as "communicationTestedAt",
        cp.first_visit_validated_at as "firstVisitValidatedAt",
        cp.first_visit_validated_closeout_id as "firstVisitValidatedCloseoutId",
        cp.clinic_use_validated_at as "clinicUseValidatedAt",
        cp.clinic_use_validated_hash as "clinicUseValidatedHash",
        cp.clinic_acceptance_at as "clinicAcceptanceAt",
        cp.clinic_acceptance_by_user_id as "clinicAcceptanceByUserId",
        cp.last_contact_at as "lastContactAt",
        cp.last_contact_outcome as "lastContactOutcome",
        cp.target_start_on as "targetStartOn",
        cp.next_review_at as "nextReviewAt",
        cp.version,
        cp.created_at as "createdAt",
        cp.updated_at as "updatedAt",
        p.billing_status as "billingStatus",
        p.subscription_tier as "subscriptionTier",
        p.trial_ends_at as "trialEndsAt",
        p.country,
        p.settings,
        va.verified_admins as "verifiedAdmins",
        coalesce(le.active_location_count, 0)::int as "activeLocationCount",
        coalesce(le.active_location_ids, ARRAY[]::uuid[]) as "activeLocationIds",
        me.activated_evidence_key as "activatedEvidenceKey",
        me.activated_at as "activatedAt",
        me.payment_method_evidence_key as "paymentMethodEvidenceKey",
        me.payment_method_collected_at as "paymentMethodCollectedAt",
        me.first_positive_payment_evidence_key as "firstPositivePaymentEvidenceKey",
        me.first_positive_payment_at as "firstPositivePaymentAt",
        cu.first_visit_closeout_id as "firstVisitCloseoutId",
        cu.first_visit_completed_at as "firstVisitCompletedAt",
        coalesce(cu.distinct_clinic_days, 0)::int as "distinctClinicDays",
        coalesce(cu.clinic_use_days, '[]'::jsonb) as "clinicUseDays",
        case
          when exists (
            select 1 from location_messaging lm
            where lm.practice_id = cp.practice_id
              and lm.deleted_at is null
              and lm.registration_status = 'active'
              and lm.provider_profile_ready = true
              and lm.enabled = true
          ) then 'ready'
          when exists (
            select 1 from location_messaging lm
            where lm.practice_id = cp.practice_id
              and lm.deleted_at is null
              and lm.registration_status = 'active'
          ) then 'carrier_approved_sending_off'
          when exists (
            select 1 from messaging_registrations mr
            where mr.practice_id = cp.practice_id
              and mr.deleted_at is null
              and mr.status in ('action_required', 'failed', 'suspended')
          ) then 'action_required'
          when exists (
            select 1 from messaging_registrations mr
            where mr.practice_id = cp.practice_id
              and mr.deleted_at is null
          ) then 'pending'
          else 'not_configured'
        end as "smsStatus",
        latest.created_at as "lastChangedAt",
        latest.actor_identity as "lastChangedBy",
        latest.reason as "lastChangeReason"
      from clinic_pilots cp
      join practices p
        on p.id = cp.practice_id
       and p.deleted_at is null
       and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      join lateral (
        select e.created_at, e.actor_identity, e.reason
        from clinic_pilot_events e
        where e.clinic_pilot_id = cp.id
          and e.practice_id = cp.practice_id
        order by e.created_at desc, e.id desc
        limit 1
      ) latest on true
      left join verified_admins va on va.practice_id = cp.practice_id
      left join location_evidence le on le.practice_id = cp.practice_id
      left join milestone_evidence me on me.practice_id = cp.practice_id
      left join clinic_use cu on cu.practice_id = cp.practice_id
      order by
        case when cp.stage in ('completed', 'closed') then 1 else 0 end,
        cp.next_review_at asc nulls last,
        cp.created_at asc,
        cp.practice_id
    `);

    return rowsFromExecute<ClinicPilotQueueRow>(result).map((row) => {
      const setup = recoverySetupState(row.settings);
      const verifiedAdmins = row.verifiedAdmins ?? [];
      const trialEndsAt = asDate(row.trialEndsAt);
      const evidence: ClinicPilotEvidence = {
        verifiedAdmin: verifiedAdmins.length > 0,
        verifiedAdmins,
        verifiedAdminUserIds: verifiedAdmins.map((admin) => admin.id),
        activeLocationCount: Number(row.activeLocationCount) || 0,
        activeLocationIds: row.activeLocationIds ?? [],
        setupComplete: setup.completed,
        setupCompletedAt: setup.completedAt,
        activatedEvidenceKey: row.activatedEvidenceKey,
        activatedAt: asDate(row.activatedAt),
        firstVisitCloseoutId: row.firstVisitCloseoutId,
        firstVisitCompletedAt: asDate(row.firstVisitCompletedAt),
        distinctClinicDays: Number(row.distinctClinicDays) || 0,
        clinicUseDays: row.clinicUseDays ?? [],
        paymentMethodEvidenceKey: row.paymentMethodEvidenceKey,
        paymentMethodCollectedAt: asDate(row.paymentMethodCollectedAt),
        firstPositivePaymentEvidenceKey: row.firstPositivePaymentEvidenceKey,
        firstPositivePaymentAt: asDate(row.firstPositivePaymentAt),
        billingStatus: row.billingStatus,
        subscriptionTier: row.subscriptionTier,
        trialEndsAt,
        hostedFullAccess: hasHostedFullAccess(
          row.subscriptionTier,
          row.billingStatus,
          trialEndsAt,
          new Date(),
          true,
        ),
        country: row.country,
        jurisdictionConfirmed: hasExplicitPracticeJurisdiction(
          row.settings,
          row.country,
        ),
        smsStatus: row.smsStatus,
      };
      const firstVisitValidationCurrent = Boolean(
        row.firstVisitValidatedAt &&
        row.firstVisitValidatedCloseoutId &&
        row.firstVisitValidatedCloseoutId === evidence.firstVisitCloseoutId,
      );
      const clinicUseValidationCurrent = Boolean(
        row.clinicUseValidatedAt &&
        row.clinicUseValidatedHash &&
        row.clinicUseValidatedHash === clinicUseEvidenceHash(evidence),
      );
      const {
        settings: _settings,
        activeLocationCount: _activeLocationCount,
        activeLocationIds: _activeLocationIds,
        activatedEvidenceKey: _activatedEvidenceKey,
        activatedAt: _activatedAt,
        paymentMethodEvidenceKey: _paymentMethodEvidenceKey,
        paymentMethodCollectedAt: _paymentMethodCollectedAt,
        firstPositivePaymentEvidenceKey: _firstPositivePaymentEvidenceKey,
        firstPositivePaymentAt: _firstPositivePaymentAt,
        firstVisitCloseoutId: _firstVisitCloseoutId,
        firstVisitCompletedAt: _firstVisitCompletedAt,
        distinctClinicDays: _distinctClinicDays,
        clinicUseDays: _clinicUseDays,
        firstVisitValidatedCloseoutId: _firstVisitValidatedCloseoutId,
        clinicUseValidatedHash: _clinicUseValidatedHash,
        ...pilot
      } = row;
      return {
        ...pilot,
        verifiedAdmins,
        version: Number(row.version),
        lastContactAt: asDate(row.lastContactAt),
        nextReviewAt: asDate(row.nextReviewAt),
        trialEndsAt,
        createdAt: asDate(row.createdAt)!,
        updatedAt: asDate(row.updatedAt)!,
        communicationTestedAt: asDate(row.communicationTestedAt),
        firstVisitValidatedAt: asDate(row.firstVisitValidatedAt),
        clinicUseValidatedAt: asDate(row.clinicUseValidatedAt),
        clinicAcceptanceAt: asDate(row.clinicAcceptanceAt),
        lastChangedAt: asDate(row.lastChangedAt)!,
        setupStage: setup.stage,
        firstVisitValidationCurrent,
        clinicUseValidationCurrent,
        evidence: {
          verifiedAdmin: evidence.verifiedAdmin,
          activeLocationCount: evidence.activeLocationCount,
          setupComplete: evidence.setupComplete,
          activatedAt: evidence.activatedAt,
          firstVisitCompletedAt: evidence.firstVisitCompletedAt,
          distinctClinicDays: evidence.distinctClinicDays,
          paymentMethodCollectedAt: evidence.paymentMethodCollectedAt,
          firstPositivePaymentAt: evidence.firstPositivePaymentAt,
          hostedFullAccess: evidence.hostedFullAccess,
          country: evidence.country,
          jurisdictionConfirmed: evidence.jurisdictionConfirmed,
        },
        gateIssues: clinicPilotGateIssues(
          {
            practiceId: row.practiceId,
            cohortKey: row.cohortKey,
            workflow: row.workflow,
            stage: row.stage,
            decision: row.decision,
            qualificationChecklist: row.qualificationChecklist,
            readinessChecklist: row.readinessChecklist,
            blockerCodes: row.blockerCodes,
            nextAction: row.nextAction,
            supportCadence: row.supportCadence,
            communicationMode: row.communicationMode,
            communicationTested: Boolean(row.communicationTestedAt),
            firstVisitValidated: firstVisitValidationCurrent,
            clinicUseValidated: clinicUseValidationCurrent,
            clinicAcceptanceConfirmed: Boolean(row.clinicAcceptanceAt),
            clinicAcceptanceByUserId: row.clinicAcceptanceByUserId,
            lastContactAt: row.lastContactAt
              ? (asDate(row.lastContactAt)?.toISOString() ?? null)
              : null,
            lastContactOutcome: row.lastContactOutcome,
            targetStartOn: row.targetStartOn,
            nextReviewAt: row.nextReviewAt
              ? (asDate(row.nextReviewAt)?.toISOString() ?? null)
              : null,
          },
          evidence,
        ),
      };
    });
  });
}

async function loadGateEvidence(
  tx: Database,
  practiceId: string,
): Promise<ClinicPilotEvidence> {
  const result = await tx.execute(sql`
    with practice_scope as (
      select
        p.id,
        p.settings,
        p.timezone,
        p.billing_status,
        p.subscription_tier,
        p.trial_ends_at,
        p.country
      from practices p
      where p.id = ${practiceId}
        and p.deleted_at is null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      for update
    ), eligible_closeouts as (
      select
        vc.id as closeout_id,
        vc.completed_at,
        (vc.completed_at at time zone p.timezone)::date as local_date
      from practice_scope p
      join visit_closeouts vc on vc.practice_id = p.id
      join appointments a
        on a.id = vc.appointment_id
       and a.practice_id = p.id
       and a.deleted_at is null
      left join clinic_pilots pilot on pilot.practice_id = p.id
      where vc.status = 'completed'
        and vc.completed_at is not null
        and vc.completed_at >= coalesce(pilot.created_at, now())
        and vc.deleted_at is null
        and not (
          coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
            @> to_jsonb(a.id::text)
        )
    ), clinic_use_days as (
      select distinct on (local_date)
        closeout_id, completed_at, local_date
      from eligible_closeouts
      order by local_date, completed_at, closeout_id
    ), ranked_clinic_use_days as (
      select
        clinic_use_days.*,
        row_number() over (order by completed_at, closeout_id) as day_rank
      from clinic_use_days
    ), clinic_use as (
      select
        (array_agg(closeout_id order by completed_at, closeout_id))[1]
          as first_visit_closeout_id,
        min(completed_at) as first_visit_completed_at,
        count(*)::int as distinct_clinic_days,
        jsonb_agg(
          jsonb_build_object(
            'closeoutId', closeout_id,
            'completedAt', completed_at,
            'localDate', local_date
          ) order by completed_at, closeout_id
        ) filter (where day_rank <= 5) as clinic_use_days
      from ranked_clinic_use_days
    )
    select
      coalesce((
        select jsonb_agg(
          jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)
          order by u.created_at, u.id
        ) from users u
        where u.practice_id = p.id
          and u.role = 'admin'
          and u.email_verified_at is not null
          and u.deleted_at is null
      ), '[]'::jsonb) as "verifiedAdmins",
      coalesce((
        select array_agg(l.id order by l.id) from locations l
        where l.practice_id = p.id and l.deleted_at is null
      ), ARRAY[]::uuid[]) as "activeLocationIds",
      p.settings,
      (
        select pcm.evidence_key
        from practice_conversion_milestones pcm
        where pcm.practice_id = p.id and pcm.milestone = 'activated'
        limit 1
      ) as "activatedEvidenceKey",
      (
        select pcm.occurred_at
        from practice_conversion_milestones pcm
        where pcm.practice_id = p.id and pcm.milestone = 'activated'
        limit 1
      ) as "activatedAt",
      (
        select pcm.evidence_key
        from practice_conversion_milestones pcm
        where pcm.practice_id = p.id
          and pcm.milestone = 'payment_method_collected'
        limit 1
      ) as "paymentMethodEvidenceKey",
      (
        select pcm.occurred_at
        from practice_conversion_milestones pcm
        where pcm.practice_id = p.id
          and pcm.milestone = 'payment_method_collected'
        limit 1
      ) as "paymentMethodCollectedAt",
      (
        select pcm.evidence_key
        from practice_conversion_milestones pcm
        where pcm.practice_id = p.id
          and pcm.milestone = 'first_positive_payment'
        limit 1
      ) as "firstPositivePaymentEvidenceKey",
      (
        select pcm.occurred_at
        from practice_conversion_milestones pcm
        where pcm.practice_id = p.id
          and pcm.milestone = 'first_positive_payment'
        limit 1
      ) as "firstPositivePaymentAt",
      cu.first_visit_closeout_id as "firstVisitCloseoutId",
      cu.first_visit_completed_at as "firstVisitCompletedAt",
      coalesce(cu.distinct_clinic_days, 0)::int as "distinctClinicDays",
      coalesce(cu.clinic_use_days, '[]'::jsonb) as "clinicUseDays",
      p.billing_status as "billingStatus",
      p.subscription_tier as "subscriptionTier",
      p.trial_ends_at as "trialEndsAt",
      p.country,
      case
        when exists (
          select 1 from location_messaging lm
          where lm.practice_id = p.id
            and lm.deleted_at is null
            and lm.registration_status = 'active'
            and lm.provider_profile_ready = true
            and lm.enabled = true
        ) then 'ready'
        when exists (
          select 1 from location_messaging lm
          where lm.practice_id = p.id
            and lm.deleted_at is null
            and lm.registration_status = 'active'
        ) then 'carrier_approved_sending_off'
        when exists (
          select 1 from messaging_registrations mr
          where mr.practice_id = p.id
            and mr.deleted_at is null
            and mr.status in ('action_required', 'failed', 'suspended')
        ) then 'action_required'
        when exists (
          select 1 from messaging_registrations mr
          where mr.practice_id = p.id and mr.deleted_at is null
        ) then 'pending'
        else 'not_configured'
      end as "smsStatus"
    from practice_scope p
    cross join clinic_use cu
  `);
  const row = rowsFromExecute<{
    verifiedAdmins: Array<{ id: string; name: string; email: string }>;
    activeLocationIds: string[];
    settings: unknown;
    activatedEvidenceKey: string | null;
    activatedAt: Date | string | null;
    firstVisitCloseoutId: string | null;
    firstVisitCompletedAt: Date | string | null;
    distinctClinicDays: number | string;
    clinicUseDays: ClinicPilotEvidence["clinicUseDays"];
    paymentMethodEvidenceKey: string | null;
    paymentMethodCollectedAt: Date | string | null;
    firstPositivePaymentEvidenceKey: string | null;
    firstPositivePaymentAt: Date | string | null;
    billingStatus: string;
    subscriptionTier: string;
    trialEndsAt: Date | string | null;
    country: string;
    smsStatus: ClinicPilotSmsStatus;
  }>(result)[0];
  if (!row) {
    throw new ClinicPilotNotFoundError(
      "The practice does not exist or is excluded from clinic operations.",
    );
  }
  const setup = recoverySetupState(row.settings);
  const trialEndsAt = asDate(row.trialEndsAt);
  return {
    verifiedAdmin: row.verifiedAdmins.length > 0,
    verifiedAdmins: row.verifiedAdmins,
    verifiedAdminUserIds: row.verifiedAdmins.map((admin) => admin.id),
    activeLocationCount: row.activeLocationIds.length,
    activeLocationIds: row.activeLocationIds,
    setupComplete: setup.completed,
    setupCompletedAt: setup.completedAt,
    activatedEvidenceKey: row.activatedEvidenceKey,
    activatedAt: asDate(row.activatedAt),
    firstVisitCloseoutId: row.firstVisitCloseoutId,
    firstVisitCompletedAt: asDate(row.firstVisitCompletedAt),
    distinctClinicDays: Number(row.distinctClinicDays) || 0,
    clinicUseDays: row.clinicUseDays,
    paymentMethodEvidenceKey: row.paymentMethodEvidenceKey,
    paymentMethodCollectedAt: asDate(row.paymentMethodCollectedAt),
    firstPositivePaymentEvidenceKey: row.firstPositivePaymentEvidenceKey,
    firstPositivePaymentAt: asDate(row.firstPositivePaymentAt),
    billingStatus: row.billingStatus,
    subscriptionTier: row.subscriptionTier,
    trialEndsAt,
    hostedFullAccess: hasHostedFullAccess(
      row.subscriptionTier,
      row.billingStatus,
      trialEndsAt,
      new Date(),
      true,
    ),
    country: row.country,
    jurisdictionConfirmed: hasExplicitPracticeJurisdiction(
      row.settings,
      row.country,
    ),
    smsStatus: row.smsStatus,
  };
}

export async function saveClinicPilot(
  db: Database,
  input: SaveClinicPilotInput,
  actorIdentity: string,
) {
  const cleanBlockers = [...new Set(input.blockerCodes)].sort();
  const normalized: SaveClinicPilotInput = {
    ...input,
    blockerCodes: cleanBlockers,
  };
  const hash = payloadHash(normalized);
  const actor = actorIdentity.trim().toLowerCase();

  return withSystem(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`clinic-pilot:${input.practiceId}`}, 0))`,
    );

    const replay = await tx
      .select({
        practiceId: clinicPilotEvents.practiceId,
        payloadHash: clinicPilotEvents.payloadHash,
        projectionVersion: clinicPilotEvents.projectionVersion,
      })
      .from(clinicPilotEvents)
      .where(eq(clinicPilotEvents.operationId, input.operationId))
      .limit(1);
    if (replay[0]) {
      if (
        replay[0].practiceId !== input.practiceId ||
        replay[0].payloadHash !== hash
      ) {
        throw new ClinicPilotConflictError(
          "This operation id was already used for a different pilot change.",
        );
      }
      return {
        practiceId: replay[0].practiceId,
        version: replay[0].projectionVersion,
        replayed: true,
      };
    }

    const current = await tx
      .select({
        id: clinicPilots.id,
        version: clinicPilots.version,
        communicationTestedAt: clinicPilots.communicationTestedAt,
        firstVisitValidatedAt: clinicPilots.firstVisitValidatedAt,
        firstVisitValidatedCloseoutId:
          clinicPilots.firstVisitValidatedCloseoutId,
        clinicUseValidatedAt: clinicPilots.clinicUseValidatedAt,
        clinicUseValidatedHash: clinicPilots.clinicUseValidatedHash,
        clinicAcceptanceAt: clinicPilots.clinicAcceptanceAt,
        clinicAcceptanceByUserId: clinicPilots.clinicAcceptanceByUserId,
      })
      .from(clinicPilots)
      .where(eq(clinicPilots.practiceId, input.practiceId))
      .limit(1);

    const evidence = await loadGateEvidence(tx, input.practiceId);
    const changedAt = new Date();
    const communicationTestedAt = normalized.communicationTested
      ? (current[0]?.communicationTestedAt ?? changedAt)
      : null;
    const firstVisitValidatedCloseoutId = normalized.firstVisitValidated
      ? evidence.firstVisitCloseoutId
      : null;
    const firstVisitValidatedAt = firstVisitValidatedCloseoutId
      ? current[0]?.firstVisitValidatedCloseoutId ===
          firstVisitValidatedCloseoutId && current[0]?.firstVisitValidatedAt
        ? current[0].firstVisitValidatedAt
        : changedAt
      : null;
    const clinicUseValidatedHash = normalized.clinicUseValidated
      ? clinicUseEvidenceHash(evidence)
      : null;
    const clinicUseValidatedAt = clinicUseValidatedHash
      ? current[0]?.clinicUseValidatedHash === clinicUseValidatedHash &&
        current[0]?.clinicUseValidatedAt
        ? current[0].clinicUseValidatedAt
        : changedAt
      : null;
    const clinicAcceptanceAt = normalized.clinicAcceptanceConfirmed
      ? current[0]?.clinicAcceptanceByUserId ===
          normalized.clinicAcceptanceByUserId && current[0]?.clinicAcceptanceAt
        ? current[0].clinicAcceptanceAt
        : changedAt
      : null;
    const issues = clinicPilotGateIssues(
      {
        practiceId: normalized.practiceId,
        cohortKey: normalized.cohortKey,
        workflow: normalized.workflow,
        stage: normalized.stage,
        decision: normalized.decision,
        qualificationChecklist: normalized.qualificationChecklist,
        readinessChecklist: normalized.readinessChecklist,
        blockerCodes: normalized.blockerCodes,
        nextAction: normalized.nextAction,
        supportCadence: normalized.supportCadence,
        communicationMode: normalized.communicationMode,
        communicationTested: Boolean(communicationTestedAt),
        firstVisitValidated: normalized.firstVisitValidated,
        clinicUseValidated: normalized.clinicUseValidated,
        clinicAcceptanceConfirmed: Boolean(clinicAcceptanceAt),
        clinicAcceptanceByUserId: normalized.clinicAcceptanceByUserId,
        lastContactAt: normalized.lastContactAt,
        lastContactOutcome: normalized.lastContactOutcome,
        targetStartOn: normalized.targetStartOn,
        nextReviewAt: normalized.nextReviewAt,
      },
      evidence,
    );
    if (issues.length > 0) {
      throw new ClinicPilotEligibilityError(issues.join(" "));
    }

    const values = {
      cohortKey: normalized.cohortKey,
      workflow: normalized.workflow,
      stage: normalized.stage,
      decision: normalized.decision,
      qualificationChecklist: normalized.qualificationChecklist,
      readinessChecklist: normalized.readinessChecklist,
      blockerCodes: normalized.blockerCodes,
      nextAction: normalized.nextAction,
      supportCadence: normalized.supportCadence,
      ownerIdentity: actor,
      communicationMode: normalized.communicationMode,
      communicationTestedAt,
      firstVisitValidatedAt,
      firstVisitValidatedCloseoutId,
      clinicUseValidatedAt,
      clinicUseValidatedHash,
      clinicAcceptanceAt,
      clinicAcceptanceByUserId: clinicAcceptanceAt
        ? normalized.clinicAcceptanceByUserId
        : null,
      lastContactAt: normalized.lastContactAt
        ? new Date(normalized.lastContactAt)
        : null,
      lastContactOutcome: normalized.lastContactOutcome,
      targetStartOn: normalized.targetStartOn,
      nextReviewAt: normalized.nextReviewAt
        ? new Date(normalized.nextReviewAt)
        : null,
    };

    let pilot: { id: string; version: number } | undefined;
    let eventType: "enrolled" | "updated";
    if (!current[0]) {
      if (input.expectedVersion !== null) {
        throw new ClinicPilotConflictError(
          "The pilot changed before enrollment. Refresh and try again.",
        );
      }
      [pilot] = await tx
        .insert(clinicPilots)
        .values({ practiceId: input.practiceId, ...values })
        .returning({ id: clinicPilots.id, version: clinicPilots.version });
      eventType = "enrolled";
    } else {
      if (input.expectedVersion !== current[0].version) {
        throw new ClinicPilotConflictError(
          "The pilot changed in another session. Refresh and try again.",
        );
      }
      [pilot] = await tx
        .update(clinicPilots)
        .set({
          ...values,
          version: current[0].version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(clinicPilots.id, current[0].id),
            eq(clinicPilots.practiceId, input.practiceId),
            eq(clinicPilots.version, current[0].version),
          ),
        )
        .returning({ id: clinicPilots.id, version: clinicPilots.version });
      eventType = "updated";
    }
    if (!pilot) {
      throw new ClinicPilotConflictError(
        "The pilot changed in another session. Refresh and try again.",
      );
    }

    await tx.insert(clinicPilotEvents).values({
      clinicPilotId: pilot.id,
      practiceId: input.practiceId,
      operationId: input.operationId,
      payloadHash: hash,
      eventType,
      reason: input.reason,
      cohortKey: values.cohortKey,
      workflow: values.workflow,
      stage: values.stage,
      decision: values.decision,
      qualificationChecklist: values.qualificationChecklist,
      readinessChecklist: values.readinessChecklist,
      blockerCodes: values.blockerCodes,
      nextAction: values.nextAction,
      supportCadence: values.supportCadence,
      ownerIdentity: values.ownerIdentity,
      communicationMode: values.communicationMode,
      communicationTestedAt: values.communicationTestedAt,
      firstVisitValidatedAt: values.firstVisitValidatedAt,
      firstVisitValidatedCloseoutId: values.firstVisitValidatedCloseoutId,
      clinicUseValidatedAt: values.clinicUseValidatedAt,
      clinicUseValidatedHash: values.clinicUseValidatedHash,
      clinicAcceptanceAt: values.clinicAcceptanceAt,
      clinicAcceptanceByUserId: values.clinicAcceptanceByUserId,
      lastContactAt: values.lastContactAt,
      lastContactOutcome: values.lastContactOutcome,
      targetStartOn: values.targetStartOn,
      nextReviewAt: values.nextReviewAt,
      projectionVersion: pilot.version,
      actorIdentity: actor,
      evidenceSnapshot: evidenceSnapshot(evidence),
    });

    return {
      practiceId: input.practiceId,
      version: pilot.version,
      replayed: false,
    };
  });
}
