import { describe, expect, it } from "vitest";
import {
  clinicPilotCohortKey,
  clinicPilotGateIssues,
  type ClinicPilotEvidence,
  type SaveClinicPilotInput,
} from "../clinic-pilots";

const completeQualification = {
  supportedClinicType: true,
  supportedJurisdictionConfirmed: true,
  singleLocation: true,
  connectedModeAccepted: true,
  parallelRunAccepted: true,
  championConfirmed: true,
  supportedWorkflowConfirmed: true,
  noUnsupportedMustHave: true,
};

const completeReadiness = {
  rolesAndDevicesValidated: true,
  migrationPlanAccepted: true,
  sampleValidationAccepted: true,
  firstVisitScheduled: true,
  exportAndRollbackConfirmed: true,
  supportCadenceConfirmed: true,
};

function input(
  overrides: Partial<SaveClinicPilotInput> = {},
): Omit<SaveClinicPilotInput, "operationId" | "expectedVersion" | "reason"> {
  const full: SaveClinicPilotInput = {
    practiceId: "00000000-0000-0000-0000-000000000001",
    operationId: "00000000-0000-0000-0000-000000000002",
    expectedVersion: null,
    cohortKey: "pilot-2026-08",
    workflow: "general_practice",
    stage: "candidate",
    decision: "pending",
    qualificationChecklist: {
      ...completeQualification,
      championConfirmed: false,
    },
    readinessChecklist: {
      ...completeReadiness,
      firstVisitScheduled: false,
    },
    blockerCodes: [],
    nextAction: "confirm_fit",
    supportCadence: "daily",
    communicationMode: "email_only",
    communicationTested: false,
    firstVisitValidated: false,
    clinicUseValidated: false,
    clinicAcceptanceConfirmed: false,
    clinicAcceptanceByUserId: null,
    lastContactAt: null,
    lastContactOutcome: null,
    targetStartOn: null,
    nextReviewAt: "2026-08-11T11:00:00.000Z",
    reason: "initial_review",
    ...overrides,
  };
  const {
    operationId: _operationId,
    expectedVersion: _version,
    reason: _reason,
    ...gateInput
  } = full;
  return gateInput;
}

function evidence(
  overrides: Partial<ClinicPilotEvidence> = {},
): ClinicPilotEvidence {
  return {
    verifiedAdmin: true,
    verifiedAdmins: [
      {
        id: "00000000-0000-0000-0000-000000000003",
        name: "Clinic Admin",
        email: "clinic@example.com",
      },
    ],
    verifiedAdminUserIds: ["00000000-0000-0000-0000-000000000003"],
    activeLocationCount: 1,
    activeLocationIds: ["00000000-0000-0000-0000-000000000004"],
    setupComplete: true,
    setupCompletedAt: new Date("2026-08-01T10:00:00.000Z"),
    activatedEvidenceKey: "client:a|appointment:b",
    activatedAt: new Date("2026-08-01T12:00:00.000Z"),
    firstVisitCloseoutId: "00000000-0000-0000-0000-000000000006",
    firstVisitCompletedAt: new Date("2026-08-02T12:00:00.000Z"),
    distinctClinicDays: 5,
    clinicUseDays: [],
    paymentMethodEvidenceKey: "stripe:checkout-1",
    paymentMethodCollectedAt: new Date("2026-08-07T12:00:00.000Z"),
    firstPositivePaymentEvidenceKey: null,
    firstPositivePaymentAt: null,
    billingStatus: "trialing",
    subscriptionTier: "cloud",
    trialEndsAt: new Date("2026-08-20T12:00:00.000Z"),
    hostedFullAccess: true,
    country: "US",
    jurisdictionConfirmed: true,
    smsStatus: "not_configured",
    ...overrides,
  };
}

describe("clinic pilot gates", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");

  it("allows an incomplete candidate only when the next review is scheduled", () => {
    expect(clinicPilotGateIssues(input(), evidence(), now)).toEqual([]);
    expect(
      clinicPilotGateIssues(input({ nextReviewAt: null }), evidence(), now),
    ).toContain("Schedule the next review before saving an active pilot.");
  });

  it("requires every fit check before marking a clinic eligible", () => {
    expect(
      clinicPilotGateIssues(
        input({
          stage: "parallel_setup",
          decision: "eligible",
          nextAction: "schedule_setup",
        }),
        evidence(),
        now,
      ),
    ).toContain(
      "Complete every clinic-fit check before qualifying this pilot.",
    );
  });

  it("requires objective admin, location, readiness, and blocker evidence for approval", () => {
    const approved = input({
      stage: "visit_validation",
      decision: "approved",
      nextAction: "complete_first_visit",
      qualificationChecklist: completeQualification,
      readinessChecklist: completeReadiness,
    });
    expect(clinicPilotGateIssues(approved, evidence(), now)).toEqual([]);
    expect(
      clinicPilotGateIssues(
        {
          ...approved,
          blockerCodes: ["billing"],
          nextAction: "resolve_blockers",
        },
        evidence({
          verifiedAdmin: false,
          verifiedAdmins: [],
          verifiedAdminUserIds: [],
          activeLocationCount: 2,
          jurisdictionConfirmed: false,
        }),
        now,
      ),
    ).toEqual(
      expect.arrayContaining([
        "A verified clinic administrator is required.",
        "The controlled pilot must have exactly one active location.",
        "The clinic must explicitly confirm its jurisdiction before approval.",
        "Resolve every blocker before approving readiness.",
      ]),
    );
  });

  it("does not let an operator fabricate the clinic week or payment-method evidence", () => {
    const completed = input({
      stage: "completed",
      decision: "graduated",
      qualificationChecklist: completeQualification,
      readinessChecklist: completeReadiness,
      nextAction: "support_retention",
      communicationTested: true,
      firstVisitValidated: true,
      clinicUseValidated: true,
      clinicAcceptanceConfirmed: true,
      clinicAcceptanceByUserId: "00000000-0000-0000-0000-000000000003",
      nextReviewAt: null,
    });
    expect(
      clinicPilotGateIssues(
        completed,
        evidence({
          firstVisitCompletedAt: null,
          distinctClinicDays: 1,
          paymentMethodCollectedAt: null,
        }),
        now,
      ),
    ).toEqual(
      expect.arrayContaining([
        "Complete activation and explicitly validate one real visit before the pilot week.",
        "Five distinct clinic-use days are required before graduation review.",
        "Collect a payment method before graduating the pilot.",
      ]),
    );
  });

  it("allows graduation during a legitimate trial without fabricating paid", () => {
    expect(
      clinicPilotGateIssues(
        input({
          stage: "completed",
          decision: "graduated",
          qualificationChecklist: completeQualification,
          readinessChecklist: completeReadiness,
          nextAction: "support_retention",
          communicationTested: true,
          firstVisitValidated: true,
          clinicUseValidated: true,
          clinicAcceptanceConfirmed: true,
          clinicAcceptanceByUserId: "00000000-0000-0000-0000-000000000003",
          nextReviewAt: null,
        }),
        evidence({ firstPositivePaymentAt: null }),
        now,
      ),
    ).toEqual([]);
  });

  it("requires a bounded blocker action and paired contact evidence", () => {
    expect(
      clinicPilotGateIssues(
        input({
          blockerCodes: ["data_import"],
          lastContactAt: "2026-08-10T12:00:00.000Z",
        }),
        evidence(),
        now,
      ),
    ).toEqual(
      expect.arrayContaining([
        "Open blockers require Resolve blockers as the next action.",
        "Record the contact time and outcome together.",
      ]),
    );
  });

  it("requires current hosted access and explicit clinic acceptance to graduate", () => {
    const completed = input({
      stage: "completed",
      decision: "graduated",
      qualificationChecklist: completeQualification,
      readinessChecklist: completeReadiness,
      nextAction: "support_retention",
      communicationTested: true,
      firstVisitValidated: true,
      clinicUseValidated: true,
      nextReviewAt: null,
    });
    expect(
      clinicPilotGateIssues(
        completed,
        evidence({ hostedFullAccess: false, billingStatus: "past_due" }),
        now,
      ),
    ).toEqual(
      expect.arrayContaining([
        "The clinic must have current hosted write access before graduation.",
        "Record explicit acceptance from a verified clinic administrator.",
      ]),
    );
  });

  it("creates stable monthly cohort keys in UTC", () => {
    expect(clinicPilotCohortKey(new Date("2026-08-31T23:59:00.000Z"))).toBe(
      "pilot-2026-08",
    );
  });
});
