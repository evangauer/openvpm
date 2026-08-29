import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectClinicReadinessEvidence } from "../clinic-readiness-evidence-collector";
import { evaluateClinicReadinessRelease } from "../clinic-readiness-release";

const sha = "a".repeat(40);
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
        "Prove the multi-clinic golden workflow",
      ]),
      successfulJob("Migration history integrity", [
        "Verify append-only migration history",
      ]),
      successfulJob("RLS tenant isolation", [
        "Prove tenant/RLS pool-reuse isolation",
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

  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/actions/runs/101")) return response(ciRun);
    if (url.endsWith("/actions/runs/101/jobs?per_page=100")) {
      return response(ciJobs);
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
    if (url === "https://staging.example/api/health") return response(health);
    return response({ error: "unexpected URL" }, 404);
  }) as unknown as typeof fetch;
}

function options(fetchFn: typeof fetch) {
  return {
    releaseSha: sha,
    repository: "openvpm/openvpm",
    ciRunId: 101,
    migrationRunId: 202,
    hostedHealthUrl: "https://staging.example/api/health",
    restoreEvidencePath: restoreEvidencePath(),
    now: new Date("2026-08-29T21:00:00.000Z"),
    fetchFn,
  };
}

describe("clinic readiness evidence collector", () => {
  it("derives a GO packet only from exact-main authoritative evidence", async () => {
    const evidence = await collectClinicReadinessEvidence(
      options(authoritativeResponses()),
    );

    expect(evidence).toMatchObject({
      evidenceFormatVersion: 2,
      releaseSha: sha,
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
      },
      hostedHealth: { releaseSha: sha, statusCode: 200 },
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
