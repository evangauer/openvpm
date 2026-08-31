import { describe, expect, it } from "vitest";
import { evaluateClinicReadinessRelease } from "../clinic-readiness-release";
import { CLINICAL_DATA_AUDIT_SCHEMAS } from "../clinical-data-integrity-evidence";
import { CLINIC_PILOT_OUTCOMES } from "../clinic-pilot-release-evidence";

const now = Date.parse("2026-08-29T21:00:00.000Z");
const sha = "a".repeat(40);
const clinicalDatabaseFingerprint = "d".repeat(64);
const stagingDatabaseFingerprint = "e".repeat(64);

function healthyClinicalDataIntegrityEvidence() {
  type AuditDomain = keyof typeof CLINICAL_DATA_AUDIT_SCHEMAS;
  const audit = (domain: AuditDomain, extra: Record<string, unknown>) => ({
    version: 1,
    mode: "read_only_aggregate",
    checkedAt: "2026-08-29T20:55:00.000Z",
    databaseTargetFingerprint: clinicalDatabaseFingerprint,
    counts: Object.fromEntries(
      CLINICAL_DATA_AUDIT_SCHEMAS[domain].countFields.map((field) => [
        field,
        0,
      ]),
    ),
    releaseSafe: true,
    ...extra,
  });
  return {
    evidenceFormatVersion: 1,
    releaseSha: sha,
    collectedAt: "2026-08-29T20:55:00.000Z",
    databaseTargetFingerprint: clinicalDatabaseFingerprint,
    audits: {
      controlledSubstances: audit("controlledSubstances", { findings: [] }),
      prescriptions: audit("prescriptions", {
        findings: [],
        architectureFindings: [],
      }),
      labResults: audit("labResults", {
        architectureState: Object.fromEntries(
          CLINICAL_DATA_AUDIT_SCHEMAS.labResults.architectureFields.map(
            (field) => [field, true],
          ),
        ),
        integrityFindings: [],
        operationalFindings: [],
        architectureFindings: [],
      }),
      vaccinations: audit("vaccinations", {
        architectureState: Object.fromEntries(
          CLINICAL_DATA_AUDIT_SCHEMAS.vaccinations.architectureFields.map(
            (field) => [field, true],
          ),
        ),
        integrityFindings: [],
        operationalFindings: [],
        architectureFindings: [],
      }),
    },
  };
}

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

function healthyAuthRecoveryEvidence() {
  return {
    evidenceFormatVersion: 1,
    drillId: "auth-recovery-2026-08-29-deadbeef",
    startedAt: "2026-08-29T19:00:00.000Z",
    completedAt: "2026-08-29T20:00:00.000Z",
    policy: {
      version: "dual-control-v1",
      sha256: "c".repeat(64),
      approvedBy: "@owner-reviewer",
      approvedAt: "2026-08-29T18:00:00.000Z",
    },
    authorities: ["@recovery-one", "@recovery-two"],
    operators: {
      requester: "@recovery-one",
      approver: "@recovery-two",
    },
    controls: {
      approvalRecordedBeforeExecution: true,
      auditTrailVerified: true,
      emailOnlyRecoveryRejected: true,
      identityProofingRecorded: true,
      passwordOnlyRecoveryRejected: true,
      priorPasskeysRetired: true,
      priorSessionsRevoked: true,
      recoveryGrantExpired: true,
      recoveryGrantSingleUse: true,
      requestRecorded: true,
      twoPasskeysReenrolled: true,
    },
    evidenceSafety: {
      emailAddressesFree: true,
      localPathsFree: true,
      phiFree: true,
      secretsFree: true,
    },
    findings: {
      criticalCount: 0,
      highCount: 0,
      followUpIssueNumbers: [],
    },
  };
}

function healthyClinicPilotEvidence() {
  return {
    evidenceFormatVersion: 1,
    pilotId: "pilot-2026-08-29-deadbeef",
    releaseSha: sha,
    startedAt: "2026-08-24T14:00:00.000Z",
    completedAt: "2026-08-29T20:00:00.000Z",
    pilotScope: {
      workflow: "general_practice",
      jurisdiction: "US",
      activeLocationCount: 1,
      distinctClinicDays: 5,
    },
    outcomes: Object.fromEntries(
      CLINIC_PILOT_OUTCOMES.map((outcome) => [outcome, true]),
    ) as Record<(typeof CLINIC_PILOT_OUTCOMES)[number], boolean>,
    sourceEvidence: {
      clinicUseValidatedHash: "b".repeat(64),
      pilotProjectionVersion: 7,
    },
    approvals: {
      clinicAdministrator: {
        actorId: "user:5f55c40b-0e87-4af2-94a8-fbe97ff5ca15",
        approvedAt: "2026-08-29T20:01:00.000Z",
      },
      veterinaryClinicalOwner: {
        actorId: "github:@clinical-owner",
        approvedAt: "2026-08-29T20:02:00.000Z",
      },
      releaseOwner: {
        actorId: "github:@release-owner",
        approvedAt: "2026-08-29T20:03:00.000Z",
      },
      securityOwner: {
        actorId: "github:@security-owner",
        approvedAt: "2026-08-29T20:04:00.000Z",
      },
    },
    evidenceSafety: {
      phiFree: true,
      secretsFree: true,
      patientIdentifiersFree: true,
      contactDestinationsFree: true,
      localPathsFree: true,
    },
    findings: {
      criticalCount: 0,
      highCount: 0,
      openReleaseBlockingCount: 0,
    },
  };
}

function healthyEvidence() {
  const checks: Record<string, { ok: boolean; advisory?: boolean }> =
    Object.fromEntries(
      [
        "hostedRelease",
        "hostedDatabaseIdentity",
        "database",
        "schema",
        "hostedRlsRole",
        "hostedStorage",
        "hostedBackupFreshness",
        "hostedFileReplica",
        "hostedMfa",
        "hostedWebAuthn",
        "hostedAuthRecovery",
        "hostedPrivilegedActionSigning",
        "hostedOpsAlerting",
        "hostedCronHeartbeat",
      ].map((name) => [name, { ok: true }]),
    );
  return {
    evidenceFormatVersion: 10,
    releaseSha: sha,
    releaseApproval: {
      releaseSha: sha,
      pullRequestNumber: 88,
      pullRequestUrl: "https://github.example/pulls/88",
      baseBranch: "main",
      authorLogin: "release-author",
      reviewedHeadSha: "f".repeat(40),
      mergedAt: "2026-08-29T20:45:00.000Z",
      approvalCount: 2,
      approvals: [
        {
          reviewerLogin: "reviewer-one",
          submittedAt: "2026-08-29T20:40:00.000Z",
          reviewedHeadSha: "f".repeat(40),
        },
        {
          reviewerLogin: "reviewer-two",
          submittedAt: "2026-08-29T20:41:00.000Z",
          reviewedHeadSha: "f".repeat(40),
        },
      ],
    },
    clinicalDataIntegrity: healthyClinicalDataIntegrityEvidence(),
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
    authRecovery: healthyAuthRecoveryEvidence(),
    clinicPilot: healthyClinicPilotEvidence(),
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
      databaseTargetFingerprint: stagingDatabaseFingerprint,
      migrationRunId: 151,
      resetRunId: 171,
      syntheticDataAudit: "passed",
      hostedHealth: {
        releaseSha: sha,
        checkedAt: "2026-08-29T20:55:00.000Z",
        statusCode: 200,
        body: {
          ok: true,
          mode: "hosted",
          releaseSha: sha,
          databaseTargetFingerprint: stagingDatabaseFingerprint,
          checks: structuredClone(checks),
        },
      },
    },
    hostedHealth: {
      releaseSha: sha,
      checkedAt: "2026-08-29T20:55:00.000Z",
      statusCode: 200,
      body: {
        ok: true,
        mode: "hosted",
        releaseSha: sha,
        databaseTargetFingerprint: clinicalDatabaseFingerprint,
        checks,
      },
    },
    restoreDrill: {
      evidenceFormatVersion: 1,
      drillId: "restore-2026-08-29-deadbeef",
      releaseSha: sha,
      startedAt: "2026-08-29T19:30:00.000Z",
      completedAt: "2026-08-29T20:30:00.000Z",
      status: "passed",
      synthetic: false,
      operators: {
        requester: "@restore-operator",
        approver: "@restore-approver",
        approvedAt: "2026-08-29T19:00:00.000Z",
      },
      databaseBackup: {
        backupVersionId: "backup-provider-version-42",
        checksumSha256: "c".repeat(64),
        exportedAt: "2026-08-29T18:30:00.000Z",
        restoreTargetFingerprint: stagingDatabaseFingerprint,
        exactVersionVerified: true,
      },
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
      metrics: { rpoMs: 3_600_000, rtoMs: 3_000_000 },
      evidenceSafety: {
        phiFree: true,
        secretsFree: true,
        providerPayloadsFree: true,
        localPathsFree: true,
        patientIdentifiersFree: true,
        contactDestinationsFree: true,
      },
      findings: {
        criticalCount: 0,
        highCount: 0,
        openReleaseBlockingCount: 0,
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
      "Clinic readiness evidence format version must be 10.",
    );
  });

  it("rejects missing, stale-head, duplicate, or self release approvals", () => {
    const evidence = healthyEvidence();
    evidence.releaseApproval.approvals[0]!.reviewerLogin = "release-author";
    evidence.releaseApproval.approvals[1]!.reviewedHeadSha = "c".repeat(40);
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Release pull request lacks two distinct non-author exact-head approvals.",
    );

    delete (evidence as Partial<ReturnType<typeof healthyEvidence>>)
      .releaseApproval;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Exact release pull request approval evidence is missing.",
    );
  });

  it("rejects missing, cross-SHA, or unsafe configured clinical-data evidence", () => {
    const evidence = healthyEvidence();
    evidence.clinicalDataIntegrity.releaseSha = "c".repeat(40);
    evidence.clinicalDataIntegrity.audits.vaccinations.releaseSafe = false;
    const reasons = evaluateClinicReadinessRelease(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Clinical-data integrity evidence does not match the release SHA.",
        "Clinical-data audit vaccinations is not release-safe.",
      ]),
    );

    delete (evidence as Partial<ReturnType<typeof healthyEvidence>>)
      .clinicalDataIntegrity;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Clinical-data integrity evidence is missing.",
    );
  });

  it("rejects incomplete account-recovery drill evidence", () => {
    const evidence = healthyEvidence();
    evidence.authRecovery.operators.approver = "@recovery-one";
    evidence.authRecovery.controls.priorSessionsRevoked = false;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toEqual(
      expect.arrayContaining([
        "Account-recovery request and approval require distinct named authorities.",
        "Account-recovery drill did not prove priorSessionsRevoked.",
      ]),
    );
  });

  it("rejects missing, cross-SHA, or incomplete clinic-pilot evidence", () => {
    const evidence = healthyEvidence();
    evidence.clinicPilot.releaseSha = "c".repeat(40);
    evidence.clinicPilot.outcomes.clinicAcceptanceRecorded = false;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toEqual(
      expect.arrayContaining([
        "Clinic-pilot evidence does not match the release SHA.",
        "Clinic-pilot evidence did not prove clinicAcceptanceRecorded.",
      ]),
    );

    delete (evidence as Partial<ReturnType<typeof healthyEvidence>>)
      .clinicPilot;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Controlled clinic-pilot evidence is missing.",
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

  it("requires a successful isolated staging reset and synthetic-data audit", () => {
    const evidence = healthyEvidence();
    evidence.staging.resetRunId = 0;
    evidence.staging.syntheticDataAudit = "failed";
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toEqual(
      expect.arrayContaining([
        "Isolated staging reset run ID is missing or invalid.",
        "Isolated staging synthetic-data and contact audit has not passed.",
      ]),
    );
  });

  it("binds staging and production health to distinct expected databases", () => {
    const evidence = healthyEvidence();
    evidence.staging.hostedHealth.body.databaseTargetFingerprint =
      clinicalDatabaseFingerprint;
    evidence.staging.databaseTargetFingerprint = clinicalDatabaseFingerprint;
    const reasons = evaluateClinicReadinessRelease(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Isolated staging and clinical production use the same database target.",
      ]),
    );

    evidence.staging.databaseTargetFingerprint = stagingDatabaseFingerprint;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Staging hosted health does not match the expected database target.",
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
        "A passed, non-synthetic provider restore is required.",
      ]),
    );
  });

  it("rejects evidence from another release SHA", () => {
    const evidence = healthyEvidence();
    evidence.restoreDrill.releaseSha = "c".repeat(40);
    evidence.restoreDrill.databaseBackup.restoreTargetFingerprint = "d".repeat(
      64,
    );
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toEqual(
      expect.arrayContaining([
        "Provider-restore evidence does not match the release SHA.",
        "Provider-restore evidence does not match the isolated staging database.",
      ]),
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
