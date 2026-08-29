import { describe, expect, it } from "vitest";
import { evaluateClinicReadinessRelease } from "../clinic-readiness-release";

const now = Date.parse("2026-08-29T21:00:00.000Z");
const sha = "a".repeat(40);

function healthyIncidentResponseEvidence() {
  const scenario = {
    status: "passed",
    detection: true,
    containment: true,
    recovery: true,
    evidenceHandling: true,
    vendorCoordination: true,
    clinicNotificationDecisionRecorded: true,
    legalNotificationDecisionRecorded: true,
  };
  return {
    evidenceFormatVersion: 1,
    exerciseType: "tabletop",
    exerciseId: "tabletop-2026-08-29-deadbeef",
    startedAt: "2026-08-29T19:00:00.000Z",
    completedAt: "2026-08-29T20:00:00.000Z",
    roles: {
      incidentCommander: "@incident-lead",
      privacyLegalReviewer: "@privacy-reviewer",
      notificationAuthority: "@notification-owner",
    },
    approvals: {
      incidentCommander: {
        approver: "@incident-lead",
        approvedAt: "2026-08-29T20:01:00.000Z",
      },
      privacyLegalReviewer: {
        approver: "@privacy-reviewer",
        approvedAt: "2026-08-29T20:02:00.000Z",
      },
      notificationAuthority: {
        approver: "@notification-owner",
        approvedAt: "2026-08-29T20:03:00.000Z",
      },
    },
    scenarios: Object.fromEntries(
      [
        "database",
        "objectStore",
        "stripe",
        "emailProvider",
        "credentialCompromise",
      ].map((name) => [name, { ...scenario }]),
    ),
    evidenceSafety: {
      phiFree: true,
      secretsFree: true,
      providerPayloadsFree: true,
      localPathsFree: true,
    },
    findings: {
      criticalCount: 0,
      highCount: 0,
      followUpIssueNumbers: [],
    },
  };
}

function healthyEvidence() {
  const checks: Record<string, { ok: boolean; advisory?: boolean }> =
    Object.fromEntries(
      [
        "hostedRelease",
        "database",
        "schema",
        "hostedRlsRole",
        "hostedStorage",
        "hostedBackupFreshness",
        "hostedFileReplica",
        "hostedMfa",
        "hostedOpsAlerting",
        "hostedCronHeartbeat",
      ].map((name) => [name, { ok: true }]),
    );
  return {
    evidenceFormatVersion: 4,
    releaseSha: sha,
    ci: {
      releaseSha: sha,
      gates: {
        migrations: "passed",
        rls: "passed",
        tests: "passed",
        build: "passed",
        dependencyAudit: "passed",
      },
    },
    incidentResponse: healthyIncidentResponseEvidence(),
    repositoryGovernance: {
      checkedAt: "2026-08-29T20:55:00.000Z",
      productionEnvironment: {
        exists: true,
        canAdminsBypass: false,
        preventSelfReview: true,
        requiredReviewerCount: 1,
        usesCustomBranchPolicies: true,
        mainOnlyBranchPolicy: true,
      },
      stagingEnvironment: {
        exists: true,
        canAdminsBypass: false,
        preventSelfReview: true,
        requiredReviewerCount: 1,
        usesCustomBranchPolicies: true,
        stagingOnlyBranchPolicy: true,
      },
      mainBranch: {
        enforceAdmins: true,
        strictStatusChecks: true,
        requiredChecks: [
          "build",
          "Golden clinic workflow",
          "Migration history integrity",
          "RLS tenant isolation",
          "Analyze (actions)",
          "Analyze (javascript-typescript)",
          "Disposable restore drill",
        ],
        requiredApprovalCount: 2,
        dismissStaleReviews: true,
        requireCodeOwnerReviews: true,
        requireLastPushApproval: true,
        requireConversationResolution: true,
        allowForcePushes: false,
        allowDeletions: false,
      },
      stagingBranch: {
        enforceAdmins: true,
        strictStatusChecks: true,
        requiredChecks: [
          "build",
          "Golden clinic workflow",
          "Migration history integrity",
          "RLS tenant isolation",
          "Analyze (actions)",
          "Analyze (javascript-typescript)",
          "Disposable restore drill",
        ],
        requiredApprovalCount: 1,
        dismissStaleReviews: true,
        requireCodeOwnerReviews: true,
        requireLastPushApproval: true,
        requireConversationResolution: true,
        allowForcePushes: false,
        allowDeletions: false,
      },
    },
    staging: {
      releaseSha: sha,
      migrationRunId: 151,
      hostedHealth: {
        releaseSha: sha,
        checkedAt: "2026-08-29T20:55:00.000Z",
        statusCode: 200,
        body: {
          ok: true,
          mode: "hosted",
          releaseSha: sha,
          checks: structuredClone(checks),
        },
      },
    },
    hostedHealth: {
      releaseSha: sha,
      checkedAt: "2026-08-29T20:55:00.000Z",
      statusCode: 200,
      body: { ok: true, mode: "hosted", releaseSha: sha, checks },
    },
    restoreDrill: {
      releaseSha: sha,
      completedAt: "2026-08-29T20:30:00.000Z",
      status: "passed",
      synthetic: false,
      recoveryHold: {
        observedBeforeReconciliation: true,
        releasedAfterChecklistAndDatabaseGate: true,
      },
      independentObject: {
        objectVersionId: "provider-version-1",
        checksumSha256: "b".repeat(64),
        fileSizeBytes: 45,
        exactVersionVerified: true,
      },
      smoke: {
        authenticationResetRequired: true,
        tenantIsolation: true,
        schedulingRows: 1,
        clinicalRows: 1,
        invoiceRows: 1,
        paymentRows: 1,
        fileAccessRows: 1,
      },
    },
  };
}

describe("clinic readiness release decision", () => {
  it("returns GO only for complete, fresh, exact-SHA evidence", () => {
    expect(
      evaluateClinicReadinessRelease(healthyEvidence(), now),
    ).toMatchObject({
      decision: "GO",
      releaseSha: sha,
      reasons: [],
    });
  });

  it("fails closed when any required CI gate is absent", () => {
    const evidence = healthyEvidence();
    delete (evidence.ci.gates as Partial<typeof evidence.ci.gates>).rls;
    expect(evaluateClinicReadinessRelease(evidence, now)).toMatchObject({
      decision: "NO_GO",
      reasons: ["CI gate rls has not passed."],
    });
  });

  it("requires backup and replica health to be affirmative release gates", () => {
    const evidence = healthyEvidence();
    evidence.hostedHealth.body.checks.hostedBackupFreshness.ok = false;
    evidence.hostedHealth.body.checks.hostedFileReplica.advisory = true;
    const decision = evaluateClinicReadinessRelease(evidence, now);
    expect(decision.decision).toBe("NO_GO");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "Hosted check hostedBackupFreshness is missing or unhealthy.",
        "Hosted check hostedFileReplica is still advisory.",
      ]),
    );
  });

  it("rejects any required hosted control that was not actually asserted", () => {
    const evidence = healthyEvidence();
    evidence.hostedHealth.body.checks.hostedRlsRole.advisory = true;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Hosted check hostedRlsRole is still advisory.",
    );
  });

  it("rejects an unknown evidence format", () => {
    const evidence = healthyEvidence();
    evidence.evidenceFormatVersion = 5;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Clinic readiness evidence format version must be 4.",
    );
  });

  it("rejects missing or incomplete incident-response exercise evidence", () => {
    const evidence = healthyEvidence();
    evidence.incidentResponse.scenarios.credentialCompromise.containment = false;
    evidence.incidentResponse.roles.notificationAuthority = "@unassigned";
    const reasons = evaluateClinicReadinessRelease(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Incident-response role notificationAuthority is not assigned.",
        "Incident-response scenario credentialCompromise is missing containment.",
      ]),
    );
  });

  it("rejects a packet with no incident-response evidence", () => {
    const evidence = healthyEvidence();
    delete (evidence as Partial<ReturnType<typeof healthyEvidence>>)
      .incidentResponse;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Incident-response evidence is missing.",
    );
  });

  it("requires fresh exact-SHA isolated staging acceptance", () => {
    const evidence = healthyEvidence();
    evidence.staging.releaseSha = "c".repeat(40);
    evidence.staging.hostedHealth.checkedAt = "2026-08-29T20:00:00.000Z";
    evidence.staging.hostedHealth.body.releaseSha = "d".repeat(40);
    const decision = evaluateClinicReadinessRelease(evidence, now);
    expect(decision.decision).toBe("NO_GO");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "Isolated staging migration does not match the release SHA.",
        "Staging hosted health evidence is stale.",
        "Staging hosted health body does not identify the release SHA.",
      ]),
    );
  });

  it("rejects advisory or unhealthy isolated staging dependencies", () => {
    const evidence = healthyEvidence();
    evidence.staging.hostedHealth.body.checks.hostedFileReplica.advisory = true;
    evidence.staging.hostedHealth.body.checks.hostedBackupFreshness.ok = false;
    const reasons = evaluateClinicReadinessRelease(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Staging hosted check hostedFileReplica is still advisory.",
        "Staging hosted check hostedBackupFreshness is missing or unhealthy.",
      ]),
    );
  });

  it("rejects unsafe production review and branch governance", () => {
    const evidence = healthyEvidence();
    evidence.repositoryGovernance.productionEnvironment.canAdminsBypass = true;
    evidence.repositoryGovernance.productionEnvironment.preventSelfReview = false;
    evidence.repositoryGovernance.mainBranch.requiredApprovalCount = 0;
    evidence.repositoryGovernance.mainBranch.requiredChecks = ["build"];
    const decision = evaluateClinicReadinessRelease(evidence, now);
    expect(decision.decision).toBe("NO_GO");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "Production environment allows administrator bypass.",
        "Production environment does not prevent self-review.",
        "Main branch requires fewer than two approvals.",
        "Main branch does not require Golden clinic workflow.",
        "Main branch does not require Disposable restore drill.",
      ]),
    );
  });

  it("rejects unsafe staging environment and branch governance", () => {
    const evidence = healthyEvidence();
    evidence.repositoryGovernance.stagingEnvironment.canAdminsBypass = true;
    evidence.repositoryGovernance.stagingEnvironment.preventSelfReview = false;
    evidence.repositoryGovernance.stagingBranch.requiredApprovalCount = 0;
    evidence.repositoryGovernance.stagingBranch.requiredChecks = ["build"];
    const decision = evaluateClinicReadinessRelease(evidence, now);
    expect(decision.decision).toBe("NO_GO");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "Staging environment allows administrator bypass.",
        "Staging environment does not prevent self-review.",
        "Staging branch requires no approval.",
        "Staging branch does not require Golden clinic workflow.",
        "Staging branch does not require Disposable restore drill.",
      ]),
    );
  });

  it("rejects stale health and a synthetic-only restore drill", () => {
    const evidence = healthyEvidence();
    evidence.hostedHealth.checkedAt = "2026-08-29T20:00:00.000Z";
    evidence.restoreDrill.synthetic = true;
    const decision = evaluateClinicReadinessRelease(evidence, now);
    expect(decision.decision).toBe("NO_GO");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "Hosted health evidence is stale.",
        "A provider-backed non-synthetic restore drill is required.",
      ]),
    );
  });

  it("rejects evidence from another release SHA", () => {
    const evidence = healthyEvidence();
    evidence.restoreDrill.releaseSha = "c".repeat(40);
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Restore drill does not match the release SHA.",
    );
  });

  it("rejects a hosted response from another deployed commit", () => {
    const evidence = healthyEvidence();
    evidence.hostedHealth.body.releaseSha = "d".repeat(40);
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Hosted health body does not identify the release SHA.",
    );
  });
});
