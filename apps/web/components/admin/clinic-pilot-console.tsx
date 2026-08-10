"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  FlaskConical,
} from "lucide-react";
import { trpc } from "@/lib/trpc";

type PracticeOption = {
  id: string;
  name: string;
  analyticsExcluded: boolean;
};

const qualificationLabels = {
  supportedClinicType: "Supported clinic type",
  supportedJurisdictionConfirmed: "US pilot jurisdiction confirmed",
  singleLocation: "One-location scope",
  connectedModeAccepted: "Connected mode accepted",
  parallelRunAccepted: "Parallel run accepted",
  championConfirmed: "Clinic champion confirmed",
  supportedWorkflowConfirmed: "Target workflow supported",
  noUnsupportedMustHave: "No unsupported must-have",
} as const;

const readinessLabels = {
  rolesAndDevicesValidated: "Roles and devices validated",
  migrationPlanAccepted: "Migration plan accepted",
  sampleValidationAccepted: "Sample validation accepted",
  firstVisitScheduled: "First real visit scheduled",
  exportAndRollbackConfirmed: "Export and rollback confirmed",
  supportCadenceConfirmed: "Support cadence confirmed",
} as const;

const blockerLabels = {
  workflow_fit: "Workflow fit",
  data_import: "Data import",
  staff_training: "Staff training",
  record_accuracy: "Record accuracy",
  billing: "Billing",
  payments: "Payments",
  email: "Email",
  sms: "SMS",
  permissions: "Permissions",
  device_connectivity: "Device/connectivity",
  backup_export: "Backup/export",
  support_coverage: "Support coverage",
} as const;

const stageOptions = [
  "candidate",
  "parallel_setup",
  "visit_validation",
  "pilot_week",
  "graduation_review",
  "completed",
  "closed",
] as const;
const decisionOptions = [
  "pending",
  "eligible",
  "approved",
  "paused",
  "not_a_fit",
  "graduated",
] as const;
const nextActionOptions = [
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
const reasonOptions = [
  "initial_review",
  "clinic_feedback",
  "product_evidence",
  "support_review",
  "blocker_review",
  "graduation_decision",
] as const;
const contactOutcomeOptions = [
  "replied",
  "no_reply",
  "scheduled",
  "completed",
  "declined",
] as const;

type Qualification = Record<keyof typeof qualificationLabels, boolean>;
type Readiness = Record<keyof typeof readinessLabels, boolean>;
type Blocker = keyof typeof blockerLabels;

type DraftEvidence = {
  verifiedAdmin: boolean;
  activeLocationCount: number;
  setupComplete: boolean;
  activatedAt: Date | string | null;
  firstVisitCompletedAt: Date | string | null;
  distinctClinicDays: number;
  paymentMethodCollectedAt: Date | string | null;
  firstPositivePaymentAt: Date | string | null;
  hostedFullAccess: boolean;
  country: string;
};

type Draft = {
  practiceId: string;
  practiceName: string;
  expectedVersion: number | null;
  cohortKey: string;
  workflow: "general_practice" | "house_call";
  stage: (typeof stageOptions)[number];
  decision: (typeof decisionOptions)[number];
  qualificationChecklist: Qualification;
  readinessChecklist: Readiness;
  blockerCodes: Blocker[];
  nextAction: (typeof nextActionOptions)[number];
  supportCadence: "daily" | "twice_weekly" | "weekly";
  communicationMode: "email_only" | "email_and_sms";
  communicationTested: boolean;
  firstVisitValidated: boolean;
  clinicUseValidated: boolean;
  clinicAcceptanceConfirmed: boolean;
  clinicAcceptanceByUserId: string;
  verifiedAdmins: Array<{ id: string; name: string; email: string }>;
  evidence: DraftEvidence | null;
  smsStatus:
    | "not_configured"
    | "pending"
    | "action_required"
    | "carrier_approved_sending_off"
    | "ready";
  lastContactAt: string;
  lastContactOutcome: (typeof contactOutcomeOptions)[number] | "";
  targetStartOn: string;
  nextReviewAt: string;
  reason: (typeof reasonOptions)[number];
};

const stateDefaults: Record<
  Draft["stage"],
  { decision: Draft["decision"]; nextAction: Draft["nextAction"] }
> = {
  candidate: { decision: "pending", nextAction: "confirm_fit" },
  parallel_setup: { decision: "eligible", nextAction: "schedule_setup" },
  visit_validation: {
    decision: "approved",
    nextAction: "complete_first_visit",
  },
  pilot_week: { decision: "approved", nextAction: "review_clinic_week" },
  graduation_review: {
    decision: "approved",
    nextAction: "decide_graduation",
  },
  completed: { decision: "graduated", nextAction: "support_retention" },
  closed: { decision: "not_a_fit", nextAction: "revisit_fit" },
};

function validDecisions(draft: Draft): Draft["decision"][] {
  const primary = stateDefaults[draft.stage].decision;
  return !["candidate", "completed", "closed"].includes(draft.stage) &&
    draft.blockerCodes.length > 0
    ? [primary, "paused"]
    : [primary];
}

function validNextActions(draft: Draft): Draft["nextAction"][] {
  if (["completed", "closed"].includes(draft.stage)) {
    return [stateDefaults[draft.stage].nextAction];
  }
  if (draft.blockerCodes.length > 0) return ["resolve_blockers"];
  if (draft.decision === "paused") return ["resolve_blockers"];
  const actions: Record<Draft["stage"], Draft["nextAction"][]> = {
    candidate: ["confirm_fit"],
    parallel_setup: ["schedule_setup", "validate_import"],
    visit_validation: ["complete_first_visit", "review_communications"],
    pilot_week: [
      "review_clinic_week",
      "review_communications",
      "configure_payment",
    ],
    graduation_review: ["decide_graduation", "configure_payment"],
    completed: ["support_retention"],
    closed: ["revisit_fit"],
  };
  return actions[draft.stage];
}

function stageRequirements(draft: Draft, stage: Draft["stage"]): string[] {
  if (stage === "candidate" || stage === "closed") return [];
  const issues: string[] = [];
  const evidence = draft.evidence;
  if (!Object.values(draft.qualificationChecklist).every(Boolean)) {
    issues.push("complete clinic fit");
  }
  if (stage === "parallel_setup") return issues;
  if (!Object.values(draft.readinessChecklist).every(Boolean)) {
    issues.push("complete launch readiness");
  }
  if (!evidence?.verifiedAdmin) issues.push("verify a clinic admin");
  if (evidence?.activeLocationCount !== 1) issues.push("scope one location");
  if (!evidence?.setupComplete) issues.push("complete guided setup");
  if (evidence?.country !== "US") issues.push("use a US clinic");
  if (draft.blockerCodes.length > 0) issues.push("resolve blockers");
  if (stage === "visit_validation") return issues;
  if (!evidence?.activatedAt) issues.push("record activation");
  if (!evidence?.firstVisitCompletedAt)
    issues.push("observe a completed visit");
  if (!draft.firstVisitValidated) issues.push("validate the real visit");
  if (!draft.communicationTested) issues.push("test communications");
  if (
    draft.communicationMode === "email_and_sms" &&
    draft.smsStatus !== "ready"
  ) {
    issues.push("make SMS operational");
  }
  if (stage === "pilot_week") return issues;
  if ((evidence?.distinctClinicDays ?? 0) < 5) {
    issues.push("observe five clinic days");
  }
  if (!draft.clinicUseValidated) issues.push("validate five real clinic days");
  if (stage === "graduation_review") return issues;
  if (!evidence?.paymentMethodCollectedAt)
    issues.push("collect a payment method");
  if (!evidence?.hostedFullAccess) issues.push("restore current hosted access");
  if (!draft.clinicAcceptanceConfirmed || !draft.clinicAcceptanceByUserId) {
    issues.push("record clinic-admin acceptance");
  }
  return issues;
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function cohortKey(now = new Date()) {
  return `pilot-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function localDateTime(value: Date | string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function defaultReviewAt() {
  return localDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

function maxReviewAt(cadence: Draft["supportCadence"]) {
  const days = cadence === "daily" ? 1 : cadence === "twice_weekly" ? 4 : 7;
  return localDateTime(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

function emptyQualification(): Qualification {
  return Object.fromEntries(
    Object.keys(qualificationLabels).map((key) => [key, false]),
  ) as Qualification;
}

function emptyReadiness(): Readiness {
  return Object.fromEntries(
    Object.keys(readinessLabels).map((key) => [key, false]),
  ) as Readiness;
}

function newDraft(practice: PracticeOption): Draft {
  return {
    practiceId: practice.id,
    practiceName: practice.name,
    expectedVersion: null,
    cohortKey: cohortKey(),
    workflow: "general_practice",
    stage: "candidate",
    decision: "pending",
    qualificationChecklist: emptyQualification(),
    readinessChecklist: emptyReadiness(),
    blockerCodes: [],
    nextAction: "confirm_fit",
    supportCadence: "daily",
    communicationMode: "email_only",
    communicationTested: false,
    firstVisitValidated: false,
    clinicUseValidated: false,
    clinicAcceptanceConfirmed: false,
    clinicAcceptanceByUserId: "",
    verifiedAdmins: [],
    evidence: null,
    smsStatus: "not_configured",
    lastContactAt: "",
    lastContactOutcome: "",
    targetStartOn: "",
    nextReviewAt: defaultReviewAt(),
    reason: "initial_review",
  };
}

function EvidenceItem({ label, done }: { label: string; done: boolean }) {
  const Icon = done ? CheckCircle2 : Circle;
  return (
    <span className={done ? "text-emerald-700" : "text-muted-foreground"}>
      <Icon className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

export function ClinicPilotConsole({
  practices,
}: {
  practices: PracticeOption[];
}) {
  const utils = trpc.useUtils();
  const {
    data: pilots,
    error,
    isLoading,
  } = trpc.admin.clinicPilotQueue.useQuery(undefined, { retry: false });
  const [candidateId, setCandidateId] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = trpc.admin.saveClinicPilot.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.admin.clinicPilotQueue.invalidate(),
        utils.admin.activationRecovery.invalidate(),
      ]);
      setDraft(null);
    },
  });

  const enrolledIds = new Set(pilots?.map((pilot) => pilot.practiceId) ?? []);
  const candidates = practices.filter(
    (practice) => !practice.analyticsExcluded && !enrolledIds.has(practice.id),
  );
  const draftStageIssues = draft ? stageRequirements(draft, draft.stage) : [];

  const editPilot = (pilot: NonNullable<typeof pilots>[number]) => {
    setDraft({
      practiceId: pilot.practiceId,
      practiceName: pilot.practiceName,
      expectedVersion: pilot.version,
      cohortKey: pilot.cohortKey,
      workflow: pilot.workflow,
      stage: pilot.stage,
      decision: pilot.decision,
      qualificationChecklist: pilot.qualificationChecklist,
      readinessChecklist: pilot.readinessChecklist,
      blockerCodes: pilot.blockerCodes,
      nextAction: pilot.nextAction,
      supportCadence: pilot.supportCadence,
      communicationMode: pilot.communicationMode,
      communicationTested: Boolean(pilot.communicationTestedAt),
      firstVisitValidated: pilot.firstVisitValidationCurrent,
      clinicUseValidated: pilot.clinicUseValidationCurrent,
      clinicAcceptanceConfirmed: Boolean(pilot.clinicAcceptanceAt),
      clinicAcceptanceByUserId: pilot.clinicAcceptanceByUserId ?? "",
      verifiedAdmins: pilot.verifiedAdmins,
      evidence: pilot.evidence,
      smsStatus: pilot.smsStatus,
      lastContactAt: localDateTime(pilot.lastContactAt),
      lastContactOutcome: pilot.lastContactOutcome ?? "",
      targetStartOn: pilot.targetStartOn ?? "",
      nextReviewAt: localDateTime(pilot.nextReviewAt),
      reason: "support_review",
    });
    save.reset();
  };

  const submit = () => {
    if (!draft) return;
    const terminal = draft.stage === "completed" || draft.stage === "closed";
    save.mutate({
      practiceId: draft.practiceId,
      operationId: crypto.randomUUID(),
      expectedVersion: draft.expectedVersion,
      cohortKey: draft.cohortKey,
      workflow: draft.workflow,
      stage: draft.stage,
      decision: draft.decision,
      qualificationChecklist: draft.qualificationChecklist,
      readinessChecklist: draft.readinessChecklist,
      blockerCodes: draft.blockerCodes,
      nextAction: draft.nextAction,
      supportCadence: draft.supportCadence,
      communicationMode: draft.communicationMode,
      communicationTested: draft.communicationTested,
      firstVisitValidated: draft.firstVisitValidated,
      clinicUseValidated: draft.clinicUseValidated,
      clinicAcceptanceConfirmed: draft.clinicAcceptanceConfirmed,
      clinicAcceptanceByUserId:
        draft.clinicAcceptanceConfirmed && draft.clinicAcceptanceByUserId
          ? draft.clinicAcceptanceByUserId
          : null,
      lastContactAt: draft.lastContactAt
        ? new Date(draft.lastContactAt).toISOString()
        : null,
      lastContactOutcome: draft.lastContactOutcome || null,
      targetStartOn: draft.targetStartOn || null,
      nextReviewAt:
        terminal || !draft.nextReviewAt
          ? null
          : new Date(draft.nextReviewAt).toISOString(),
      reason: draft.reason,
    });
  };

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <FlaskConical className="h-4 w-4" />
            <span className="text-sm">First supported clinic cohort</span>
          </div>
          <p className="mt-2 max-w-3xl text-xs text-muted-foreground">
            Operator decisions are separate from product evidence. Saving here
            records an immutable, PHI-free snapshot; it never emails a clinic,
            enables texting, changes billing, or calls a provider.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Clinic to review for the pilot"
            value={candidateId}
            onChange={(event) => setCandidateId(event.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Select a registered clinic…</option>
            {candidates.map((practice) => (
              <option key={practice.id} value={practice.id}>
                {practice.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!candidateId}
            onClick={() => {
              const practice = candidates.find(
                (candidate) => candidate.id === candidateId,
              );
              if (practice) {
                setDraft(newDraft(practice));
                save.reset();
              }
            }}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Review for pilot
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-destructive">
          Could not load the pilot cohort: {error.message}
        </p>
      ) : isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Loading pilot operations…
        </p>
      ) : pilots && pilots.length > 0 ? (
        <div className="mt-5 grid gap-3">
          {pilots.map((pilot) => {
            const overdue =
              pilot.nextReviewAt &&
              new Date(pilot.nextReviewAt).getTime() < Date.now() &&
              !["completed", "closed"].includes(pilot.stage);
            return (
              <article
                key={pilot.id}
                className={`rounded-md border p-4 ${
                  overdue ? "border-amber-400 bg-amber-50/40" : "border-border"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{pilot.practiceName}</p>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">
                      {pilot.cohortKey} · {humanize(pilot.workflow)} · operator
                      stage {humanize(pilot.stage)} · decision{" "}
                      {humanize(pilot.decision)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => editPilot(pilot)}
                    className="rounded border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    Review
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">
                  <EvidenceItem
                    label={`Setup: ${pilot.setupStage}`}
                    done={pilot.evidence.setupComplete}
                  />
                  <EvidenceItem
                    label="Activated"
                    done={Boolean(pilot.evidence.activatedAt)}
                  />
                  <EvidenceItem
                    label="First visit"
                    done={Boolean(pilot.evidence.firstVisitCompletedAt)}
                  />
                  <EvidenceItem
                    label={`${pilot.evidence.distinctClinicDays}/5 clinic days`}
                    done={pilot.evidence.distinctClinicDays >= 5}
                  />
                  <EvidenceItem
                    label="Payment method"
                    done={Boolean(pilot.evidence.paymentMethodCollectedAt)}
                  />
                  <EvidenceItem
                    label="First positive payment"
                    done={Boolean(pilot.evidence.firstPositivePaymentAt)}
                  />
                  <EvidenceItem
                    label={`Current access: ${pilot.billingStatus}`}
                    done={pilot.evidence.hostedFullAccess}
                  />
                  <span className="capitalize text-muted-foreground">
                    SMS: {humanize(pilot.smsStatus)}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="capitalize">
                    Next: {humanize(pilot.nextAction)}
                  </span>
                  <span>
                    Review:{" "}
                    {pilot.nextReviewAt
                      ? new Date(pilot.nextReviewAt).toLocaleString()
                      : "closed"}
                  </span>
                  <span>Blockers: {pilot.blockerCodes.length}</span>
                  <span>
                    Audit: {new Date(pilot.lastChangedAt).toLocaleString()} by{" "}
                    {pilot.lastChangedBy}
                  </span>
                  <span>Owner: {pilot.ownerIdentity}</span>
                </div>
                {pilot.gateIssues.length > 0 ? (
                  <div className="mt-3 rounded border border-amber-300/70 bg-amber-50 p-2 text-xs text-amber-900">
                    <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                    {pilot.gateIssues.join(" ")}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          No clinic has been enrolled in the controlled cohort. Qualification is
          intentionally deliberate.
        </p>
      )}

      {draft ? (
        <div className="mt-5 rounded-md border border-primary/30 bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">Pilot review · {draft.practiceName}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Record only operational facts. Never enter client, patient,
                clinical, payment-card, or credential data here.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium">
              Workflow
              <select
                value={draft.workflow}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    workflow: event.target.value as Draft["workflow"],
                  })
                }
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm"
              >
                <option value="general_practice">General practice</option>
                <option value="house_call">House call</option>
              </select>
            </label>
            <label className="text-xs font-medium">
              Stage
              <select
                value={draft.stage}
                onChange={(event) => {
                  const stage = event.target.value as Draft["stage"];
                  const state = stateDefaults[stage];
                  setDraft({
                    ...draft,
                    stage,
                    decision: state.decision,
                    nextAction: state.nextAction,
                    nextReviewAt:
                      stage === "completed" || stage === "closed"
                        ? ""
                        : draft.nextReviewAt || defaultReviewAt(),
                  });
                }}
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm capitalize"
              >
                {stageOptions.map((option) => (
                  <option
                    key={option}
                    value={option}
                    disabled={stageRequirements(draft, option).length > 0}
                  >
                    {humanize(option)}
                    {stageRequirements(draft, option).length > 0
                      ? " · gated"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium">
              Readiness decision
              <select
                value={draft.decision}
                onChange={(event) => {
                  const decision = event.target.value as Draft["decision"];
                  setDraft({
                    ...draft,
                    decision,
                    nextAction:
                      decision === "paused"
                        ? "resolve_blockers"
                        : stateDefaults[draft.stage].nextAction,
                  });
                }}
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm capitalize"
              >
                {validDecisions(draft).map((option) => (
                  <option key={option} value={option}>
                    {humanize(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium">
              Support cadence
              <select
                value={draft.supportCadence}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    supportCadence: event.target
                      .value as Draft["supportCadence"],
                  })
                }
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm capitalize"
              >
                <option value="daily">Daily</option>
                <option value="twice_weekly">Twice weekly</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <fieldset className="rounded border border-border p-3">
              <legend className="px-1 text-xs font-semibold">
                Clinic fit · all required to qualify
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(qualificationLabels).map(([key, label]) => (
                  <label key={key} className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      disabled={
                        draft.stage === "completed" || draft.stage === "closed"
                      }
                      checked={
                        draft.qualificationChecklist[key as keyof Qualification]
                      }
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          qualificationChecklist: {
                            ...draft.qualificationChecklist,
                            [key]: event.target.checked,
                          },
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="rounded border border-border p-3">
              <legend className="px-1 text-xs font-semibold">
                Launch readiness · all required to approve
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(readinessLabels).map(([key, label]) => (
                  <label key={key} className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={draft.readinessChecklist[key as keyof Readiness]}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          readinessChecklist: {
                            ...draft.readinessChecklist,
                            [key]: event.target.checked,
                          },
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <fieldset className="mt-4 rounded border border-border p-3">
            <legend className="px-1 text-xs font-semibold">
              Evidence attestations
            </legend>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs font-medium">
                Client communication path
                <select
                  value={draft.communicationMode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      communicationMode: event.target
                        .value as Draft["communicationMode"],
                      communicationTested: false,
                    })
                  }
                  className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm"
                >
                  <option value="email_only">Verified email fallback</option>
                  <option value="email_and_sms">
                    Email and operational SMS
                  </option>
                </select>
              </label>
              <div className="grid gap-2 text-xs">
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={draft.communicationTested}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        communicationTested: event.target.checked,
                      })
                    }
                  />
                  Selected communication path was tested successfully
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={draft.firstVisitValidated}
                    disabled={
                      !draft.expectedVersion ||
                      !draft.evidence?.firstVisitCompletedAt
                    }
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        firstVisitValidated: event.target.checked,
                      })
                    }
                  />
                  Operator confirmed the observed visit was real clinic work
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={draft.clinicUseValidated}
                    disabled={
                      !draft.expectedVersion ||
                      (draft.evidence?.distinctClinicDays ?? 0) < 5
                    }
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        clinicUseValidated: event.target.checked,
                      })
                    }
                  />
                  Operator reviewed five distinct days as real clinic use
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={draft.clinicAcceptanceConfirmed}
                    disabled={
                      draft.verifiedAdmins.length === 0 ||
                      (draft.evidence?.distinctClinicDays ?? 0) < 5 ||
                      !draft.clinicUseValidated
                    }
                    onChange={(event) => {
                      const confirmed = event.target.checked;
                      setDraft({
                        ...draft,
                        clinicAcceptanceConfirmed: confirmed,
                        clinicAcceptanceByUserId: confirmed
                          ? draft.clinicAcceptanceByUserId ||
                            draft.verifiedAdmins[0]?.id ||
                            ""
                          : "",
                      });
                    }}
                  />
                  Clinic explicitly accepted the golden day and go-live
                </label>
              </div>
              {draft.clinicAcceptanceConfirmed ? (
                <label className="text-xs font-medium md:col-start-2">
                  Accepting clinic administrator
                  <select
                    value={draft.clinicAcceptanceByUserId}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        clinicAcceptanceByUserId: event.target.value,
                      })
                    }
                    className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm"
                  >
                    {draft.verifiedAdmins.map((admin) => (
                      <option key={admin.id} value={admin.id}>
                        {admin.name} · {admin.email}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="mt-4 rounded border border-border p-3">
            <legend className="px-1 text-xs font-semibold">
              Open blockers
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {Object.entries(blockerLabels).map(([key, label]) => {
                const blocker = key as Blocker;
                return (
                  <label key={key} className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      disabled={
                        draft.stage === "completed" || draft.stage === "closed"
                      }
                      checked={draft.blockerCodes.includes(blocker)}
                      onChange={(event) => {
                        const blockerCodes = event.target.checked
                          ? [...draft.blockerCodes, blocker]
                          : draft.blockerCodes.filter(
                              (item) => item !== blocker,
                            );
                        setDraft({
                          ...draft,
                          blockerCodes,
                          decision:
                            blockerCodes.length > 0 &&
                            draft.stage !== "candidate"
                              ? "paused"
                              : blockerCodes.length === 0 &&
                                  draft.decision === "paused"
                                ? stateDefaults[draft.stage].decision
                                : draft.decision,
                          nextAction:
                            blockerCodes.length > 0
                              ? "resolve_blockers"
                              : stateDefaults[draft.stage].nextAction,
                        });
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-medium">
              Next action
              <select
                value={draft.nextAction}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    nextAction: event.target.value as Draft["nextAction"],
                  })
                }
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm capitalize"
              >
                {validNextActions(draft).map((option) => (
                  <option key={option} value={option}>
                    {humanize(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium">
              Target start
              <input
                type="date"
                value={draft.targetStartOn}
                onChange={(event) =>
                  setDraft({ ...draft, targetStartOn: event.target.value })
                }
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium">
              Next review
              <input
                type="datetime-local"
                disabled={
                  draft.stage === "completed" || draft.stage === "closed"
                }
                value={draft.nextReviewAt}
                min={localDateTime(new Date())}
                max={maxReviewAt(draft.supportCadence)}
                onChange={(event) =>
                  setDraft({ ...draft, nextReviewAt: event.target.value })
                }
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm disabled:opacity-50"
              />
            </label>
            <label className="text-xs font-medium">
              Change reason
              <select
                value={draft.reason}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    reason: event.target.value as Draft["reason"],
                  })
                }
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm capitalize"
              >
                {reasonOptions.map((option) => (
                  <option key={option} value={option}>
                    {humanize(option)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium">
              Last contact
              <input
                type="datetime-local"
                value={draft.lastContactAt}
                onChange={(event) =>
                  setDraft({ ...draft, lastContactAt: event.target.value })
                }
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium">
              Contact outcome
              <select
                value={draft.lastContactOutcome}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    lastContactOutcome: event.target
                      .value as Draft["lastContactOutcome"],
                  })
                }
                className="mt-1 block w-full rounded border border-input bg-background px-2 py-2 text-sm capitalize"
              >
                <option value="">Not recorded</option>
                {contactOutcomeOptions.map((option) => (
                  <option key={option} value={option}>
                    {humanize(option)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {save.error ? (
            <p className="mt-4 text-sm text-destructive">
              Could not save pilot review: {save.error.message}
            </p>
          ) : null}
          {draftStageIssues.length > 0 ? (
            <p className="mt-4 rounded border border-amber-300/70 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              This stage is gated: {draftStageIssues.join(", ")}.
            </p>
          ) : null}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={save.isPending || draftStageIssues.length > 0}
              onClick={submit}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save audited review"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
