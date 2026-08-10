import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ClinicPilotConflictError extends Error {}
  class ClinicPilotEligibilityError extends Error {}
  class ClinicPilotNotFoundError extends Error {}
  return {
    db: { execute: vi.fn(async () => []) },
    loadClinicPilotQueue: vi.fn(async () => []),
    saveClinicPilot: vi.fn(async () => ({
      practiceId: "00000000-0000-0000-0000-0000000000aa",
      version: 1,
      replayed: false,
    })),
    ClinicPilotConflictError,
    ClinicPilotEligibilityError,
    ClinicPilotNotFoundError,
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: vi.fn(
    async (
      database: unknown,
      _practiceId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn(database),
  ),
  withSystem: vi.fn(
    async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(database),
  ),
}));
vi.mock("@/lib/admin/clinic-pilots", () => ({
  CLINIC_PILOT_BLOCKERS: [
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
  ],
  CLINIC_PILOT_CONTACT_OUTCOMES: [
    "replied",
    "no_reply",
    "scheduled",
    "completed",
    "declined",
  ],
  CLINIC_PILOT_COMMUNICATION_MODES: ["email_only", "email_and_sms"],
  CLINIC_PILOT_DECISIONS: [
    "pending",
    "eligible",
    "approved",
    "paused",
    "not_a_fit",
    "graduated",
  ],
  CLINIC_PILOT_NEXT_ACTIONS: [
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
  ],
  CLINIC_PILOT_REASONS: [
    "initial_review",
    "clinic_feedback",
    "product_evidence",
    "support_review",
    "blocker_review",
    "graduation_decision",
  ],
  CLINIC_PILOT_STAGES: [
    "candidate",
    "parallel_setup",
    "visit_validation",
    "pilot_week",
    "graduation_review",
    "completed",
    "closed",
  ],
  CLINIC_PILOT_SUPPORT_CADENCES: ["daily", "twice_weekly", "weekly"],
  CLINIC_PILOT_WORKFLOWS: ["general_practice", "house_call"],
  ClinicPilotConflictError: mocks.ClinicPilotConflictError,
  ClinicPilotEligibilityError: mocks.ClinicPilotEligibilityError,
  ClinicPilotNotFoundError: mocks.ClinicPilotNotFoundError,
  loadClinicPilotQueue: mocks.loadClinicPilotQueue,
  saveClinicPilot: mocks.saveClinicPilot,
}));

const { adminRouter } = await import("../routers/admin");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";

function caller(email = "ops@example.com") {
  return adminRouter.createCaller({
    db: mocks.db,
    session: {
      user: {
        id: "00000000-0000-0000-0000-000000000001",
        email,
        name: "Ops",
        role: "admin",
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function input() {
  return {
    practiceId: PRACTICE_ID,
    operationId: "00000000-0000-0000-0000-000000000002",
    expectedVersion: null,
    cohortKey: "pilot-2026-08",
    workflow: "general_practice" as const,
    stage: "candidate" as const,
    decision: "pending" as const,
    qualificationChecklist: {
      supportedClinicType: false,
      supportedJurisdictionConfirmed: false,
      singleLocation: false,
      connectedModeAccepted: false,
      parallelRunAccepted: false,
      championConfirmed: false,
      supportedWorkflowConfirmed: false,
      noUnsupportedMustHave: false,
    },
    readinessChecklist: {
      rolesAndDevicesValidated: false,
      migrationPlanAccepted: false,
      sampleValidationAccepted: false,
      firstVisitScheduled: false,
      exportAndRollbackConfirmed: false,
      supportCadenceConfirmed: false,
    },
    blockerCodes: [],
    nextAction: "confirm_fit" as const,
    supportCadence: "daily" as const,
    communicationMode: "email_only" as const,
    communicationTested: false,
    firstVisitValidated: false,
    clinicUseValidated: false,
    clinicAcceptanceConfirmed: false,
    clinicAcceptanceByUserId: null,
    lastContactAt: null,
    lastContactOutcome: null,
    targetStartOn: null,
    nextReviewAt: "2026-08-11T12:00:00.000Z",
    reason: "initial_review" as const,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.saveClinicPilot.mockResolvedValue({
    practiceId: PRACTICE_ID,
    version: 1,
    replayed: false,
  });
});

describe("admin clinic pilot operations", () => {
  it("rejects clinic admins before reading or mutating the cohort", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    await expect(
      caller("clinic@example.com").clinicPilotQueue(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller("clinic@example.com").saveClinicPilot(input()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.loadClinicPilotQueue).not.toHaveBeenCalled();
    expect(mocks.saveClinicPilot).not.toHaveBeenCalled();
  });

  it("accepts only the bounded PHI-free payload and attributes the operator", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    await expect(caller().saveClinicPilot(input())).resolves.toMatchObject({
      practiceId: PRACTICE_ID,
      version: 1,
    });
    expect(mocks.saveClinicPilot).toHaveBeenCalledWith(
      mocks.db,
      input(),
      "ops@example.com",
    );

    await expect(
      caller().saveClinicPilot({
        ...input(),
        notes: "Patient or participant detail must never be accepted",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps stale and failed gate decisions without hiding the reason", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.saveClinicPilot.mockRejectedValueOnce(
      new mocks.ClinicPilotConflictError("Refresh and try again."),
    );
    await expect(caller().saveClinicPilot(input())).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Refresh and try again.",
    });

    mocks.saveClinicPilot.mockRejectedValueOnce(
      new mocks.ClinicPilotEligibilityError("Complete the readiness checks."),
    );
    await expect(caller().saveClinicPilot(input())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Complete the readiness checks.",
    });
  });
});
