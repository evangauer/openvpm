import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectClinicReadinessEvidence } from "../clinic-readiness-evidence-collector";
import { evaluateClinicReadinessRelease } from "../clinic-readiness-release";
import { CLINICAL_DATA_AUDIT_SCHEMAS } from "../clinical-data-integrity-evidence";

const sha = "a".repeat(40);
const reviewedHeadSha = "f".repeat(40);
const clinicalDatabaseFingerprint = "d".repeat(64);
const stagingDatabaseFingerprint = "e".repeat(64);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function successfulStep(name: string) {
  return { name, status: "completed", conclusion: "success" };
}

function successfulJob(name: string, steps: string[] = []) {
  return {
    name,
    status: "completed",
    conclusion: "success",
    steps: steps.map(successfulStep),
  };
}

function restoreEvidencePath() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "openvpm-release-evidence-"),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, "restore.json");
  writeFileSync(
    file,
    JSON.stringify({
      evidenceFormatVersion: 1,
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
    }),
  );
  return file;
}

function incidentEvidencePath() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "openvpm-incident-evidence-"),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, "incident.json");
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
  writeFileSync(
    file,
    JSON.stringify({
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
    }),
  );
  return file;
}

function authRecoveryEvidencePath() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "openvpm-auth-recovery-evidence-"),
  );
  temporaryDirectories.push(directory);
  const file = path.join(directory, "auth-recovery.json");
  writeFileSync(
    file,
    JSON.stringify({
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
    }),
  );
  return file;
}

function clinicalAuditPaths() {
  const directory = mkdtempSync(
    path.join(tmpdir(), "openvpm-clinical-audit-evidence-"),
  );
  temporaryDirectories.push(directory);
  const base = (domain: keyof typeof CLINICAL_DATA_AUDIT_SCHEMAS) => ({
    version: 1,
    mode: "read_only_aggregate",
    checkedAt: "2026-08-29T20:58:00.000Z",
    databaseTargetFingerprint: clinicalDatabaseFingerprint,
    counts: Object.fromEntries(
      CLINICAL_DATA_AUDIT_SCHEMAS[domain].countFields.map((field) => [
        field,
        0,
      ]),
    ),
    releaseSafe: true,
  });
  const architectureState = (domain: "labResults" | "vaccinations") =>
    Object.fromEntries(
      CLINICAL_DATA_AUDIT_SCHEMAS[domain].architectureFields.map((field) => [
        field,
        true,
      ]),
    );
  const reports = {
    controlledSubstanceAuditPath: {
      file: "controlled-substances.json",
      body: { ...base("controlledSubstances"), findings: [] },
    },
    prescriptionAuditPath: {
      file: "prescriptions.json",
      body: {
        ...base("prescriptions"),
        findings: [],
        architectureFindings: [],
      },
    },
    labResultAuditPath: {
      file: "lab-results.json",
      body: {
        ...base("labResults"),
        architectureState: architectureState("labResults"),
        integrityFindings: [],
        operationalFindings: [],
        architectureFindings: [],
      },
    },
    vaccinationAuditPath: {
      file: "vaccinations.json",
      body: {
        ...base("vaccinations"),
        architectureState: architectureState("vaccinations"),
        integrityFindings: [],
        operationalFindings: [],
        architectureFindings: [],
      },
    },
  };
  return Object.fromEntries(
    Object.entries(reports).map(([name, report]) => {
      const file = path.join(directory, report.file);
      writeFileSync(file, JSON.stringify(report.body));
      return [name, file];
    }),
  ) as Record<keyof typeof reports, string>;
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authoritativeResponses(options: { missingBuildStep?: string } = {}) {
  const checks = Object.fromEntries(
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
  const buildSteps = [
    "Audit production dependencies",
    "Run pnpm test",
    "Run pnpm build",
  ].filter((name) => name !== options.missingBuildStep);
  const ciRun = {
    name: "CI",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_branch: "main",
    html_url: "https://github.example/ci",
  };
  const ciJobs = {
    total_count: 4,
    jobs: [
      successfulJob("build", buildSteps),
      successfulJob("Golden clinic workflow", [
        "Prove the golden clinic workflow and real WebAuthn ceremonies",
      ]),
      successfulJob("Migration history integrity", [
        "Verify append-only migration history",
      ]),
      successfulJob("RLS tenant isolation", [
        "Prove tenant/RLS pool-reuse isolation",
      ]),
    ],
  };
  const stagingMigrationRun = {
    name: "Apply migrations",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_branch: "staging",
    html_url: "https://github.example/staging-migration",
  };
  const stagingMigrationJobs = {
    total_count: 2,
    jobs: [
      successfulJob("validate staging request", [
        "Require exact revision confirmation",
      ]),
      successfulJob("staging", [
        "Require isolated staging database credentials",
        "Reject protected or mismatched staging project",
        "Apply migrations",
        "Re-apply row-level security",
        "Verify schema matches the code",
      ]),
    ],
  };
  const stagingResetRun = {
    name: "Reset isolated staging",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_branch: "staging",
    html_url: "https://github.example/staging-reset",
  };
  const stagingResetJobs = {
    total_count: 2,
    jobs: [
      successfulJob("validate staging reset request", [
        "Require exact staging revision and destructive confirmation",
      ]),
      successfulJob("reset isolated staging", [
        "Reject protected or mismatched staging project",
        "Verify database target identity",
        "Reset every staging application table",
        "Seed repository-owned synthetic clinic",
        "Verify exact schema and migration history",
        "Prove synthetic-only staging data and contact boundaries",
      ]),
    ],
  };
  const migrationRun = {
    name: "Apply migrations",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_branch: "main",
    html_url: "https://github.example/migration",
  };
  const migrationJobs = {
    total_count: 2,
    jobs: [
      successfulJob("validate production request", [
        "Require exact revision confirmation",
      ]),
      successfulJob("production", [
        "Apply migrations",
        "Re-apply row-level security",
        "Verify schema matches the code",
      ]),
    ],
  };
  const health = {
    ok: true,
    service: "openvpm-web",
    mode: "hosted",
    releaseSha: sha,
    checks,
  };
  const productionEnvironment = {
    name: "Production",
    can_admins_bypass: false,
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User" }],
      },
      { type: "branch_policy" },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
  const productionBranchPolicies = {
    total_count: 1,
    branch_policies: [{ name: "main", type: "branch" }],
  };
  const stagingEnvironment = {
    ...productionEnvironment,
    name: "Staging",
  };
  const stagingBranchPolicies = {
    total_count: 1,
    branch_policies: [{ name: "staging", type: "branch" }],
  };
  const mainProtection = {
    required_status_checks: {
      strict: true,
      contexts: [
        "build",
        "Golden clinic workflow",
        "Migration history integrity",
        "RLS tenant isolation",
        "Analyze (actions)",
        "Analyze (javascript-typescript)",
        "Disposable restore drill",
      ],
      checks: [],
    },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
      required_approving_review_count: 2,
    },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
  const stagingProtection = {
    ...mainProtection,
    required_pull_request_reviews: {
      ...mainProtection.required_pull_request_reviews,
      required_approving_review_count: 1,
    },
  };
  const releasePullRequest = {
    number: 88,
    state: "closed",
    merged_at: "2026-08-29T20:45:00.000Z",
    merge_commit_sha: sha,
    html_url: "https://github.example/pulls/88",
    user: { login: "release-author" },
    head: { sha: reviewedHeadSha },
    base: { ref: "main" },
  };
  const releaseReviews = [
    {
      state: "APPROVED",
      submitted_at: "2026-08-29T20:40:00.000Z",
      commit_id: reviewedHeadSha,
      user: { login: "reviewer-one" },
    },
    {
      state: "APPROVED",
      submitted_at: "2026-08-29T20:41:00.000Z",
      commit_id: reviewedHeadSha,
      user: { login: "reviewer-two" },
    },
  ];

  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/actions/runs/101")) return response(ciRun);
    if (url.endsWith("/actions/runs/101/jobs?per_page=100")) {
      return response(ciJobs);
    }
    if (url.endsWith("/actions/runs/151")) {
      return response(stagingMigrationRun);
    }
    if (url.endsWith("/actions/runs/151/jobs?per_page=100")) {
      return response(stagingMigrationJobs);
    }
    if (url.endsWith("/actions/runs/171")) return response(stagingResetRun);
    if (url.endsWith("/actions/runs/171/jobs?per_page=100")) {
      return response(stagingResetJobs);
    }
    if (url.endsWith("/actions/runs/202")) return response(migrationRun);
    if (url.endsWith("/actions/runs/202/jobs?per_page=100")) {
      return response(migrationJobs);
    }
    if (url.endsWith("/environments/Production")) {
      return response(productionEnvironment);
    }
    if (url.endsWith("/environments/Production/deployment-branch-policies")) {
      return response(productionBranchPolicies);
    }
    if (url.endsWith("/branches/main/protection")) {
      return response(mainProtection);
    }
    if (url.endsWith("/environments/Staging")) {
      return response(stagingEnvironment);
    }
    if (url.endsWith("/environments/Staging/deployment-branch-policies")) {
      return response(stagingBranchPolicies);
    }
    if (url.endsWith("/branches/staging/protection")) {
      return response(stagingProtection);
    }
    if (url.endsWith(`/commits/${sha}/pulls?per_page=100`)) {
      return response([releasePullRequest]);
    }
    if (url.endsWith("/pulls/88/reviews?per_page=100")) {
      return response(releaseReviews);
    }
    if (url === "https://staging.example/api/health") {
      return response({
        ...health,
        databaseTargetFingerprint: stagingDatabaseFingerprint,
      });
    }
    if (url === "https://production.example/api/health")
      return response({
        ...health,
        databaseTargetFingerprint: clinicalDatabaseFingerprint,
      });
    return response({ error: "unexpected URL" }, 404);
  }) as unknown as typeof fetch;
}

function options(fetchFn: typeof fetch) {
  return {
    releaseSha: sha,
    repository: "openvpm/openvpm",
    ciRunId: 101,
    stagingMigrationRunId: 151,
    stagingResetRunId: 171,
    stagingDatabaseFingerprint,
    migrationRunId: 202,
    stagingHealthUrl: "https://staging.example/api/health",
    hostedHealthUrl: "https://production.example/api/health",
    restoreEvidencePath: restoreEvidencePath(),
    incidentEvidencePath: incidentEvidencePath(),
    authRecoveryEvidencePath: authRecoveryEvidencePath(),
    clinicalDatabaseFingerprint,
    ...clinicalAuditPaths(),
    now: new Date("2026-08-29T21:00:00.000Z"),
    fetchFn,
  };
}

describe("clinic readiness evidence collector", () => {
  it("derives a GO packet only from exact staging and production evidence", async () => {
    const evidence = await collectClinicReadinessEvidence(
      options(authoritativeResponses()),
    );

    expect(evidence).toMatchObject({
      evidenceFormatVersion: 8,
      releaseSha: sha,
      releaseApproval: {
        releaseSha: sha,
        pullRequestNumber: 88,
        authorLogin: "release-author",
        reviewedHeadSha,
        approvalCount: 2,
        approvals: [
          { reviewerLogin: "reviewer-one", reviewedHeadSha },
          { reviewerLogin: "reviewer-two", reviewedHeadSha },
        ],
      },
      ci: {
        releaseSha: sha,
        ciRunId: 101,
        migrationRunId: 202,
        gates: {
          migrations: "passed",
          rls: "passed",
          tests: "passed",
          build: "passed",
          dependencyAudit: "passed",
        },
      },
      repositoryGovernance: {
        productionEnvironment: {
          canAdminsBypass: false,
          preventSelfReview: true,
          requiredReviewerCount: 1,
          mainOnlyBranchPolicy: true,
        },
        mainBranch: {
          requiredApprovalCount: 2,
          requireCodeOwnerReviews: true,
        },
        stagingEnvironment: {
          canAdminsBypass: false,
          preventSelfReview: true,
          requiredReviewerCount: 1,
          stagingOnlyBranchPolicy: true,
        },
        stagingBranch: {
          requiredApprovalCount: 1,
          requireCodeOwnerReviews: true,
        },
      },
      staging: {
        releaseSha: sha,
        databaseTargetFingerprint: stagingDatabaseFingerprint,
        migrationRunId: 151,
        resetRunId: 171,
        syntheticDataAudit: "passed",
        hostedHealth: { releaseSha: sha, statusCode: 200 },
      },
      hostedHealth: { releaseSha: sha, statusCode: 200 },
      incidentResponse: {
        exerciseId: "tabletop-2026-08-29-deadbeef",
      },
      authRecovery: {
        drillId: "auth-recovery-2026-08-29-deadbeef",
      },
      clinicalDataIntegrity: {
        releaseSha: sha,
        databaseTargetFingerprint: clinicalDatabaseFingerprint,
        audits: {
          controlledSubstances: { releaseSafe: true },
          prescriptions: { releaseSafe: true },
          labResults: { releaseSafe: true },
          vaccinations: { releaseSafe: true },
        },
      },
      restoreDrill: { releaseSha: sha, synthetic: false },
    });
    expect(
      evaluateClinicReadinessRelease(
        evidence,
        Date.parse("2026-08-29T21:00:00.000Z"),
      ).decision,
    ).toBe("GO");
  });

  it("rejects a successful CI run from another commit", async () => {
    const fetchFn = authoritativeResponses();
    const wrapped = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const result = await fetchFn(input, init);
        if (String(input).endsWith("/actions/runs/101")) {
          const body = await result.json();
          return response({ ...body, head_sha: "c".repeat(40) });
        }
        return result;
      },
    ) as unknown as typeof fetch;

    await expect(
      collectClinicReadinessEvidence(options(wrapped)),
    ).rejects.toThrow("CI must be a successful exact-SHA CI run from main.");
  });

  it("rejects a release commit without two exact-head non-author approvals", async () => {
    const fetchFn = authoritativeResponses();
    const wrapped = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const result = await fetchFn(input, init);
        if (String(input).endsWith("/pulls/88/reviews?per_page=100")) {
          const reviews = (await result.json()) as Array<
            Record<string, unknown>
          >;
          return response([
            reviews[0],
            { ...reviews[1], commit_id: "c".repeat(40) },
          ]);
        }
        return result;
      },
    ) as unknown as typeof fetch;

    await expect(
      collectClinicReadinessEvidence(options(wrapped)),
    ).rejects.toThrow(
      "Release pull request requires two distinct non-author approvals on its exact head.",
    );
  });

  it("rejects a direct-push release SHA with no merged main pull request", async () => {
    const fetchFn = authoritativeResponses();
    const wrapped = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith(`/commits/${sha}/pulls?per_page=100`)) {
          return response([]);
        }
        return fetchFn(input, init);
      },
    ) as unknown as typeof fetch;

    await expect(
      collectClinicReadinessEvidence(options(wrapped)),
    ).rejects.toThrow(
      "Release SHA must identify exactly one merged pull request to main.",
    );
  });

  it("rejects a green job whose required dependency audit step is absent", async () => {
    await expect(
      collectClinicReadinessEvidence(
        options(
          authoritativeResponses({
            missingBuildStep: "Audit production dependencies",
          }),
        ),
      ),
    ).rejects.toThrow(
      "GitHub job build must contain step Audit production dependencies.",
    );
  });

  it("rejects unsafe incident evidence before assembling a release packet", async () => {
    const value = options(authoritativeResponses());
    writeFileSync(
      value.incidentEvidencePath,
      JSON.stringify({ evidenceFormatVersion: 1, notes: "not permitted" }),
    );
    await expect(collectClinicReadinessEvidence(value)).rejects.toThrow(
      "Incident-response evidence is incomplete, stale, or unsafe.",
    );
  });

  it("rejects incomplete recovery evidence before assembling a release packet", async () => {
    const value = options(authoritativeResponses());
    writeFileSync(
      value.authRecoveryEvidencePath,
      JSON.stringify({ evidenceFormatVersion: 1, notes: "not permitted" }),
    );
    await expect(collectClinicReadinessEvidence(value)).rejects.toThrow(
      "Account-recovery evidence is incomplete, stale, or unsafe.",
    );
  });

  it("rejects an unsafe configured clinical-data audit before assembling a release packet", async () => {
    const value = options(authoritativeResponses());
    writeFileSync(
      value.prescriptionAuditPath,
      JSON.stringify({
        version: 1,
        mode: "read_only_aggregate",
        checkedAt: "2026-08-29T20:58:00.000Z",
        databaseTargetFingerprint: clinicalDatabaseFingerprint,
        counts: { totalPrescriptions: 1 },
        releaseSafe: false,
        findings: [],
        architectureFindings: ["interaction_catalog_is_empty"],
      }),
    );
    await expect(collectClinicReadinessEvidence(value)).rejects.toThrow(
      "Clinical-data integrity evidence is incomplete, stale, cross-target, or unsafe.",
    );
  });

  it("does not disclose an unreadable incident evidence path", async () => {
    const value = options(authoritativeResponses());
    const privatePath = path.join(
      tmpdir(),
      "private-clinic-name",
      "incident-evidence.json",
    );
    value.incidentEvidencePath = privatePath;

    const error = await collectClinicReadinessEvidence(value).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Incident-response evidence is unavailable or unreadable.",
    );
    expect((error as Error).message).not.toContain(privatePath);
    expect((error as Error).message).not.toContain("private-clinic-name");
  });

  it("rejects staging migration evidence dispatched from main", async () => {
    const fetchFn = authoritativeResponses();
    const wrapped = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const result = await fetchFn(input, init);
        if (String(input).endsWith("/actions/runs/151")) {
          const body = await result.json();
          return response({ ...body, head_branch: "main" });
        }
        return result;
      },
    ) as unknown as typeof fetch;

    await expect(
      collectClinicReadinessEvidence(options(wrapped)),
    ).rejects.toThrow(
      "Staging migration must be a successful exact-SHA Apply migrations run from staging.",
    );
  });

  it("rejects a staging reset that is not exact-SHA staging evidence", async () => {
    const fetchFn = authoritativeResponses();
    const wrapped = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const result = await fetchFn(input, init);
        if (String(input).endsWith("/actions/runs/171")) {
          const body = await result.json();
          return response({ ...body, head_sha: "d".repeat(40) });
        }
        return result;
      },
    ) as unknown as typeof fetch;

    await expect(
      collectClinicReadinessEvidence(options(wrapped)),
    ).rejects.toThrow(
      "Staging reset must be a successful exact-SHA Reset isolated staging run from staging.",
    );
  });

  it("fails closed when GitHub omits permissive governance booleans", async () => {
    const fetchFn = authoritativeResponses();
    const wrapped = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const result = await fetchFn(input, init);
        const url = String(input);
        if (url.endsWith("/environments/Staging")) {
          const { can_admins_bypass: _omitted, ...body } = await result.json();
          return response(body);
        }
        if (url.endsWith("/branches/staging/protection")) {
          const {
            allow_force_pushes: _omittedForcePushes,
            allow_deletions: _omittedDeletions,
            ...body
          } = await result.json();
          return response(body);
        }
        return result;
      },
    ) as unknown as typeof fetch;

    const evidence = await collectClinicReadinessEvidence(options(wrapped));
    expect(evidence.repositoryGovernance.stagingEnvironment).toMatchObject({
      canAdminsBypass: true,
    });
    expect(evidence.repositoryGovernance.stagingBranch).toMatchObject({
      allowForcePushes: true,
      allowDeletions: true,
    });
    expect(
      evaluateClinicReadinessRelease(
        evidence,
        Date.parse(evidence.repositoryGovernance.checkedAt),
      ),
    ).toMatchObject({ decision: "NO_GO" });
  });

  it("rejects an incomplete GitHub job listing", async () => {
    const fetchFn = authoritativeResponses();
    const wrapped = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const result = await fetchFn(input, init);
        if (String(input).endsWith("/actions/runs/101/jobs?per_page=100")) {
          const body = await result.json();
          return response({ ...(body as object), total_count: 101 });
        }
        return result;
      },
    ) as unknown as typeof fetch;

    await expect(
      collectClinicReadinessEvidence(options(wrapped)),
    ).rejects.toThrow("CI jobs response is incomplete.");
  });

  it("collects unsafe governance as explicit NO_GO evidence", async () => {
    const fetchFn = authoritativeResponses();
    const wrapped = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const result = await fetchFn(input, init);
        if (String(input).endsWith("/environments/Production")) {
          const body = (await result.json()) as Record<string, unknown>;
          return response({ ...body, can_admins_bypass: true });
        }
        return result;
      },
    ) as unknown as typeof fetch;

    const evidence = await collectClinicReadinessEvidence(options(wrapped));
    expect(
      evaluateClinicReadinessRelease(
        evidence,
        Date.parse("2026-08-29T21:00:00.000Z"),
      ).reasons,
    ).toContain("Production environment allows administrator bypass.");
  });

  it("rejects a non-HTTPS or decorated health endpoint before fetching", async () => {
    const invalid = options(authoritativeResponses());
    invalid.hostedHealthUrl = "http://staging.example/api/health?token=secret";
    await expect(collectClinicReadinessEvidence(invalid)).rejects.toThrow(
      "Hosted health URL must be an HTTPS /api/health endpoint",
    );
  });
});
