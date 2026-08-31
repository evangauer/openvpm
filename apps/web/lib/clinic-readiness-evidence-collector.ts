import { readFileSync, statSync } from "node:fs";
import { evaluateIncidentResponseEvidence } from "./incident-response-evidence";
import { evaluateAuthRecoveryEvidence } from "./auth-recovery-evidence";
import { evaluateClinicalDataIntegrityEvidence } from "./clinical-data-integrity-evidence";
import { evaluateClinicPilotReleaseEvidence } from "./clinic-pilot-release-evidence";
import {
  clinicPilotActorHash,
  evaluateClinicPilotProjectionEvidence,
} from "./clinic-pilot-projection-evidence";
import { evaluateProviderRestoreReleaseEvidence } from "./provider-restore-release-evidence";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

type WorkflowStep = {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
};

type WorkflowJob = {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  steps?: unknown;
};

type WorkflowRun = {
  name?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  head_sha?: unknown;
  head_branch?: unknown;
  html_url?: unknown;
};

type JobsResponse = { jobs?: unknown; total_count?: unknown };

type ProtectionRule = {
  type?: unknown;
  prevent_self_review?: unknown;
  reviewers?: unknown;
};

type EnvironmentResponse = {
  name?: unknown;
  can_admins_bypass?: unknown;
  protection_rules?: unknown;
  deployment_branch_policy?: unknown;
};

type BranchPoliciesResponse = {
  total_count?: unknown;
  branch_policies?: unknown;
};

type BranchProtectionResponse = {
  required_status_checks?: unknown;
  required_pull_request_reviews?: unknown;
  enforce_admins?: unknown;
  required_conversation_resolution?: unknown;
  allow_force_pushes?: unknown;
  allow_deletions?: unknown;
};

type PullRequestResponse = {
  number?: unknown;
  state?: unknown;
  merged_at?: unknown;
  merge_commit_sha?: unknown;
  html_url?: unknown;
  user?: unknown;
  head?: unknown;
  base?: unknown;
};

type PullReviewResponse = {
  state?: unknown;
  submitted_at?: unknown;
  commit_id?: unknown;
  user?: unknown;
};

export type ClinicReadinessEvidenceCollectionOptions = {
  releaseSha: string;
  repository: string;
  ciRunId: number;
  stagingMigrationRunId: number;
  stagingResetRunId: number;
  stagingDatabaseFingerprint: string;
  migrationRunId: number;
  stagingHealthUrl: string;
  hostedHealthUrl: string;
  restoreEvidencePath: string;
  incidentEvidencePath: string;
  authRecoveryEvidencePath: string;
  clinicPilotEvidencePath: string;
  clinicPilotProjectionAuditPath: string;
  clinicalDatabaseFingerprint: string;
  controlledSubstanceAuditPath: string;
  prescriptionAuditPath: string;
  labResultAuditPath: string;
  vaccinationAuditPath: string;
  githubToken?: string;
  now?: Date;
  fetchFn?: typeof fetch;
};

function exactSha(value: string): string {
  if (!SHA_PATTERN.test(value)) {
    throw new Error("Release SHA must be an exact 40-character commit.");
  }
  return value.toLowerCase();
}

function exactFingerprint(value: string, label = "Clinical database"): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} fingerprint must be an exact SHA-256 value.`);
  }
  return value.toLowerCase();
}

function runId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function regularBoundedJsonFile(path: string, label: string): unknown {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`${label} is unavailable or unreadable.`);
  }
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  if (stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`${label} exceeds the 1 MB safety limit.`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

async function boundedJsonResponse(response: Response, label: string) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_EVIDENCE_BYTES) {
    throw new Error(`${label} exceeds the 1 MB safety limit.`);
  }
  if (!response.body) throw new Error(`${label} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_EVIDENCE_BYTES) {
      await reader.cancel();
      throw new Error(`${label} exceeds the 1 MB safety limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

function workflowJob(value: unknown): WorkflowJob | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowJob)
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function successfulJob(jobs: WorkflowJob[], name: string): WorkflowJob {
  const matches = jobs.filter((job) => job.name === name);
  if (matches.length !== 1) {
    throw new Error(`GitHub evidence must contain exactly one ${name} job.`);
  }
  const job = matches[0];
  if (job.status !== "completed" || job.conclusion !== "success") {
    throw new Error(`GitHub job ${name} has not passed.`);
  }
  return job;
}

function requireSuccessfulStep(job: WorkflowJob, name: string) {
  const steps = Array.isArray(job.steps)
    ? job.steps.filter((value): value is WorkflowStep =>
        Boolean(value && typeof value === "object" && !Array.isArray(value)),
      )
    : [];
  const matches = steps.filter((step) => step.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `GitHub job ${String(job.name)} must contain step ${name}.`,
    );
  }
  if (
    matches[0].status !== "completed" ||
    matches[0].conclusion !== "success"
  ) {
    throw new Error(
      `GitHub step ${String(job.name)} / ${name} has not passed.`,
    );
  }
}

function verifyRun(
  run: WorkflowRun,
  expected: {
    label: string;
    name: string;
    event: string;
    releaseSha: string;
    branch: "main" | "staging";
  },
) {
  if (
    run.name !== expected.name ||
    run.event !== expected.event ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_branch !== expected.branch ||
    typeof run.head_sha !== "string" ||
    run.head_sha.toLowerCase() !== expected.releaseSha
  ) {
    throw new Error(
      `${expected.label} must be a successful exact-SHA ${expected.name} run from ${expected.branch}.`,
    );
  }
}

function githubHeaders(token?: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openvpm-clinic-readiness",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubJson(
  fetchFn: typeof fetch,
  url: string,
  token: string | undefined,
  label: string,
) {
  const response = await fetchFn(url, {
    headers: githubHeaders(token),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${label} request failed with HTTP ${response.status}.`);
  }
  return boundedJsonResponse(response, label);
}

function githubLogin(value: unknown, label: string): string {
  const login = record(value)?.login;
  if (
    typeof login !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(login)
  ) {
    throw new Error(`${label} identity is invalid.`);
  }
  return login;
}

export async function releaseApprovalEvidence(
  fetchFn: typeof fetch,
  repository: string,
  releaseSha: string,
  token: string | undefined,
) {
  const root = `https://api.github.com/repos/${repository}`;
  const associated = await githubJson(
    fetchFn,
    `${root}/commits/${releaseSha}/pulls?per_page=100`,
    token,
    "Release pull requests",
  );
  if (!Array.isArray(associated) || associated.length >= 100) {
    throw new Error("Release pull request evidence is incomplete.");
  }
  const candidates = associated.filter((value) => {
    const pull = record(value) as PullRequestResponse | null;
    const base = record(pull?.base);
    return (
      pull?.state === "closed" &&
      typeof pull.merged_at === "string" &&
      typeof pull.merge_commit_sha === "string" &&
      pull.merge_commit_sha.toLowerCase() === releaseSha &&
      base?.ref === "main"
    );
  });
  if (candidates.length !== 1) {
    throw new Error(
      "Release SHA must identify exactly one merged pull request to main.",
    );
  }

  const pull = candidates[0] as PullRequestResponse;
  const pullNumber = pull.number;
  const headSha = record(pull.head)?.sha;
  const mergedAtMs = Date.parse(String(pull.merged_at));
  if (
    !Number.isSafeInteger(pullNumber) ||
    Number(pullNumber) <= 0 ||
    typeof headSha !== "string" ||
    !SHA_PATTERN.test(headSha) ||
    !Number.isFinite(mergedAtMs) ||
    typeof pull.html_url !== "string"
  ) {
    throw new Error("Release pull request evidence is invalid.");
  }
  const authorLogin = githubLogin(pull.user, "Release pull request author");
  const rawReviews = await githubJson(
    fetchFn,
    `${root}/pulls/${pullNumber}/reviews?per_page=100`,
    token,
    "Release pull request reviews",
  );
  if (!Array.isArray(rawReviews) || rawReviews.length >= 100) {
    throw new Error("Release pull request review evidence is incomplete.");
  }

  const latestDecisiveByReviewer = new Map<
    string,
    {
      reviewerLogin: string;
      state: string;
      submittedAt: string;
      submittedAtMs: number;
      reviewedHeadSha: string;
    }
  >();
  for (const value of rawReviews) {
    const review = record(value) as PullReviewResponse | null;
    if (
      review?.state !== "APPROVED" &&
      review?.state !== "CHANGES_REQUESTED" &&
      review?.state !== "DISMISSED"
    ) {
      continue;
    }
    const reviewerLogin = githubLogin(
      review.user,
      "Release pull request reviewer",
    );
    const submittedAt = review.submitted_at;
    const reviewedHeadSha = review.commit_id;
    const submittedAtMs = Date.parse(String(submittedAt));
    if (
      typeof submittedAt !== "string" ||
      !Number.isFinite(submittedAtMs) ||
      submittedAtMs > mergedAtMs ||
      typeof reviewedHeadSha !== "string" ||
      !SHA_PATTERN.test(reviewedHeadSha)
    ) {
      throw new Error("Release pull request review evidence is invalid.");
    }
    const key = reviewerLogin.toLowerCase();
    const current = latestDecisiveByReviewer.get(key);
    if (!current || current.submittedAtMs < submittedAtMs) {
      latestDecisiveByReviewer.set(key, {
        reviewerLogin,
        state: review.state,
        submittedAt,
        submittedAtMs,
        reviewedHeadSha: reviewedHeadSha.toLowerCase(),
      });
    }
  }

  if (
    [...latestDecisiveByReviewer.values()].some(
      (review) => review.state === "CHANGES_REQUESTED",
    )
  ) {
    throw new Error("Release pull request has an unresolved change request.");
  }
  const approvals = [...latestDecisiveByReviewer.values()]
    .filter(
      (review) =>
        review.state === "APPROVED" &&
        review.reviewedHeadSha === headSha.toLowerCase() &&
        review.reviewerLogin.toLowerCase() !== authorLogin.toLowerCase(),
    )
    .sort((left, right) =>
      left.reviewerLogin.localeCompare(right.reviewerLogin),
    )
    .map(({ reviewerLogin, submittedAt, reviewedHeadSha }) => ({
      reviewerLogin,
      submittedAt,
      reviewedHeadSha,
    }));
  if (approvals.length < 2) {
    throw new Error(
      "Release pull request requires two distinct non-author approvals on its exact head.",
    );
  }

  return {
    releaseSha,
    pullRequestNumber: pullNumber as number,
    pullRequestUrl: pull.html_url,
    baseBranch: "main",
    authorLogin,
    reviewedHeadSha: headSha.toLowerCase(),
    mergedAt: pull.merged_at as string,
    approvalCount: approvals.length,
    approvals,
  };
}

async function githubRunAndJobs(
  fetchFn: typeof fetch,
  repository: string,
  id: number,
  token: string | undefined,
  label: string,
): Promise<{ run: WorkflowRun; jobs: WorkflowJob[] }> {
  const root = `https://api.github.com/repos/${repository}/actions/runs/${id}`;
  const [run, jobsResponse] = await Promise.all([
    githubJson(fetchFn, root, token, `${label} run`),
    githubJson(fetchFn, `${root}/jobs?per_page=100`, token, `${label} jobs`),
  ]);
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error(`${label} run response is invalid.`);
  }
  if (
    !jobsResponse ||
    typeof jobsResponse !== "object" ||
    Array.isArray(jobsResponse)
  ) {
    throw new Error(`${label} jobs response is invalid.`);
  }
  const jobsPayload = jobsResponse as JobsResponse;
  const rawJobs = jobsPayload.jobs;
  const jobs = Array.isArray(rawJobs)
    ? rawJobs.map(workflowJob).filter((job): job is WorkflowJob => job !== null)
    : [];
  if (
    typeof jobsPayload.total_count !== "number" ||
    jobsPayload.total_count !== jobs.length
  ) {
    throw new Error(`${label} jobs response is incomplete.`);
  }
  return { run: run as WorkflowRun, jobs };
}

function requiredCheckNames(value: unknown): string[] {
  const checks = record(value);
  const contexts = Array.isArray(checks?.contexts)
    ? checks.contexts.filter((item): item is string => typeof item === "string")
    : [];
  const appChecks = Array.isArray(checks?.checks)
    ? checks.checks
        .map(record)
        .map((item) => item?.context)
        .filter((item): item is string => typeof item === "string")
    : [];
  return [...new Set([...contexts, ...appChecks])].sort();
}

function environmentGovernance(
  rawEnvironment: unknown,
  rawPolicies: unknown,
  expectedEnvironment: "Production" | "Staging",
  expectedBranch: "main" | "staging",
) {
  const environment = record(rawEnvironment) as EnvironmentResponse | null;
  const policies = record(rawPolicies) as BranchPoliciesResponse | null;
  if (!environment || !policies) {
    throw new Error(`${expectedEnvironment} governance response is invalid.`);
  }
  const protectionRules = Array.isArray(environment.protection_rules)
    ? environment.protection_rules
        .map(record)
        .filter((item): item is ProtectionRule => item !== null)
    : [];
  const reviewerRules = protectionRules.filter(
    (rule) => rule.type === "required_reviewers",
  );
  const reviewerRule = reviewerRules.length === 1 ? reviewerRules[0] : null;
  const deploymentPolicy = record(environment.deployment_branch_policy);
  const branchPolicies = Array.isArray(policies.branch_policies)
    ? policies.branch_policies.map(record).filter((item) => item !== null)
    : [];
  return {
    exists: environment.name === expectedEnvironment,
    canAdminsBypass: environment.can_admins_bypass !== false,
    preventSelfReview: reviewerRule?.prevent_self_review === true,
    requiredReviewerCount: Array.isArray(reviewerRule?.reviewers)
      ? reviewerRule.reviewers.length
      : 0,
    usesCustomBranchPolicies:
      deploymentPolicy?.protected_branches === false &&
      deploymentPolicy?.custom_branch_policies === true,
    onlyExpectedBranchPolicy:
      policies.total_count === 1 &&
      branchPolicies.length === 1 &&
      branchPolicies[0]?.name === expectedBranch &&
      branchPolicies[0]?.type === "branch",
  };
}

function branchGovernance(rawProtection: unknown, label: string) {
  const protection = record(rawProtection) as BranchProtectionResponse | null;
  if (!protection) throw new Error(`${label} protection response is invalid.`);
  const reviews = record(protection.required_pull_request_reviews);
  return {
    enforceAdmins: record(protection.enforce_admins)?.enabled === true,
    strictStatusChecks:
      record(protection.required_status_checks)?.strict === true,
    requiredChecks: requiredCheckNames(protection.required_status_checks),
    requiredApprovalCount:
      typeof reviews?.required_approving_review_count === "number"
        ? reviews.required_approving_review_count
        : 0,
    dismissStaleReviews: reviews?.dismiss_stale_reviews === true,
    requireCodeOwnerReviews: reviews?.require_code_owner_reviews === true,
    requireLastPushApproval: reviews?.require_last_push_approval === true,
    requireConversationResolution:
      record(protection.required_conversation_resolution)?.enabled === true,
    allowForcePushes: record(protection.allow_force_pushes)?.enabled !== false,
    allowDeletions: record(protection.allow_deletions)?.enabled !== false,
  };
}

async function repositoryGovernanceEvidence(
  fetchFn: typeof fetch,
  repository: string,
  token: string | undefined,
  checkedAt: string,
) {
  const root = `https://api.github.com/repos/${repository}`;
  const [
    rawProductionEnvironment,
    rawProductionPolicies,
    rawMainProtection,
    rawStagingEnvironment,
    rawStagingPolicies,
    rawStagingProtection,
  ] = await Promise.all([
    githubJson(
      fetchFn,
      `${root}/environments/Production`,
      token,
      "Production environment",
    ),
    githubJson(
      fetchFn,
      `${root}/environments/Production/deployment-branch-policies`,
      token,
      "Production deployment branch policies",
    ),
    githubJson(
      fetchFn,
      `${root}/branches/main/protection`,
      token,
      "Main branch protection",
    ),
    githubJson(
      fetchFn,
      `${root}/environments/Staging`,
      token,
      "Staging environment",
    ),
    githubJson(
      fetchFn,
      `${root}/environments/Staging/deployment-branch-policies`,
      token,
      "Staging deployment branch policies",
    ),
    githubJson(
      fetchFn,
      `${root}/branches/staging/protection`,
      token,
      "Staging branch protection",
    ),
  ]);
  const productionEnvironment = environmentGovernance(
    rawProductionEnvironment,
    rawProductionPolicies,
    "Production",
    "main",
  );
  const stagingEnvironment = environmentGovernance(
    rawStagingEnvironment,
    rawStagingPolicies,
    "Staging",
    "staging",
  );
  const {
    onlyExpectedBranchPolicy: mainOnlyBranchPolicy,
    ...productionEnvironmentEvidence
  } = productionEnvironment;
  const {
    onlyExpectedBranchPolicy: stagingOnlyBranchPolicy,
    ...stagingEnvironmentEvidence
  } = stagingEnvironment;
  return {
    checkedAt,
    productionEnvironment: {
      ...productionEnvironmentEvidence,
      mainOnlyBranchPolicy,
    },
    stagingEnvironment: {
      ...stagingEnvironmentEvidence,
      stagingOnlyBranchPolicy,
    },
    mainBranch: branchGovernance(rawMainProtection, "Main branch"),
    stagingBranch: branchGovernance(rawStagingProtection, "Staging branch"),
  };
}

function hostedHealthEndpoint(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/api/health" ||
    url.search
  ) {
    throw new Error(
      "Hosted health URL must be an HTTPS /api/health endpoint without credentials, query, or fragment.",
    );
  }
  return url;
}

export async function collectClinicReadinessEvidence(
  options: ClinicReadinessEvidenceCollectionOptions,
) {
  const releaseSha = exactSha(options.releaseSha);
  const clinicalDatabaseFingerprint = exactFingerprint(
    options.clinicalDatabaseFingerprint,
  );
  const stagingDatabaseFingerprint = exactFingerprint(
    options.stagingDatabaseFingerprint,
    "Staging database",
  );
  if (stagingDatabaseFingerprint === clinicalDatabaseFingerprint) {
    throw new Error(
      "Staging and clinical production database fingerprints must be distinct.",
    );
  }
  if (!REPOSITORY_PATTERN.test(options.repository)) {
    throw new Error("GitHub repository must use the owner/name form.");
  }
  const ciRunId = runId(options.ciRunId, "CI run ID");
  const stagingMigrationRunId = runId(
    options.stagingMigrationRunId,
    "Staging migration run ID",
  );
  const stagingResetRunId = runId(
    options.stagingResetRunId,
    "Staging reset run ID",
  );
  const migrationRunId = runId(
    options.migrationRunId,
    "Production migration run ID",
  );
  const stagingHealthUrl = hostedHealthEndpoint(options.stagingHealthUrl);
  const healthUrl = hostedHealthEndpoint(options.hostedHealthUrl);
  const fetchFn = options.fetchFn ?? fetch;
  const checkedAt = (options.now ?? new Date()).toISOString();

  const [
    ci,
    stagingMigration,
    stagingReset,
    migration,
    stagingHealthResponse,
    healthResponse,
    repositoryGovernance,
    releaseApproval,
  ] = await Promise.all([
    githubRunAndJobs(
      fetchFn,
      options.repository,
      ciRunId,
      options.githubToken,
      "CI",
    ),
    githubRunAndJobs(
      fetchFn,
      options.repository,
      stagingMigrationRunId,
      options.githubToken,
      "Staging migration",
    ),
    githubRunAndJobs(
      fetchFn,
      options.repository,
      stagingResetRunId,
      options.githubToken,
      "Staging reset",
    ),
    githubRunAndJobs(
      fetchFn,
      options.repository,
      migrationRunId,
      options.githubToken,
      "Production migration",
    ),
    fetchFn(stagingHealthUrl, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }),
    fetchFn(healthUrl, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }),
    repositoryGovernanceEvidence(
      fetchFn,
      options.repository,
      options.githubToken,
      checkedAt,
    ),
    releaseApprovalEvidence(
      fetchFn,
      options.repository,
      releaseSha,
      options.githubToken,
    ),
  ]);

  verifyRun(ci.run, {
    label: "CI",
    name: "CI",
    event: "push",
    releaseSha,
    branch: "main",
  });
  verifyRun(stagingMigration.run, {
    label: "Staging migration",
    name: "Apply migrations",
    event: "workflow_dispatch",
    releaseSha,
    branch: "staging",
  });
  verifyRun(stagingReset.run, {
    label: "Staging reset",
    name: "Reset isolated staging",
    event: "workflow_dispatch",
    releaseSha,
    branch: "staging",
  });
  verifyRun(migration.run, {
    label: "Production migration",
    name: "Apply migrations",
    event: "workflow_dispatch",
    releaseSha,
    branch: "main",
  });

  const buildJob = successfulJob(ci.jobs, "build");
  const goldenJob = successfulJob(ci.jobs, "Golden clinic workflow");
  const migrationIntegrityJob = successfulJob(
    ci.jobs,
    "Migration history integrity",
  );
  const rlsJob = successfulJob(ci.jobs, "RLS tenant isolation");
  const stagingValidationJob = successfulJob(
    stagingMigration.jobs,
    "validate staging request",
  );
  const stagingMigrationJob = successfulJob(stagingMigration.jobs, "staging");
  const stagingResetValidationJob = successfulJob(
    stagingReset.jobs,
    "validate staging reset request",
  );
  const stagingResetJob = successfulJob(
    stagingReset.jobs,
    "reset isolated staging",
  );
  const validationJob = successfulJob(
    migration.jobs,
    "validate production request",
  );
  const productionMigrationJob = successfulJob(migration.jobs, "production");

  requireSuccessfulStep(buildJob, "Audit production dependencies");
  requireSuccessfulStep(buildJob, "Run pnpm test");
  requireSuccessfulStep(buildJob, "Run pnpm build");
  requireSuccessfulStep(
    goldenJob,
    "Prove the golden clinic workflow and real WebAuthn ceremonies",
  );
  requireSuccessfulStep(
    migrationIntegrityJob,
    "Verify append-only migration history",
  );
  requireSuccessfulStep(rlsJob, "Prove tenant/RLS pool-reuse isolation");
  requireSuccessfulStep(
    stagingValidationJob,
    "Require exact revision confirmation",
  );
  requireSuccessfulStep(
    stagingMigrationJob,
    "Require isolated staging database credentials",
  );
  requireSuccessfulStep(
    stagingMigrationJob,
    "Reject protected or mismatched staging project",
  );
  requireSuccessfulStep(stagingMigrationJob, "Apply migrations");
  requireSuccessfulStep(stagingMigrationJob, "Re-apply row-level security");
  requireSuccessfulStep(stagingMigrationJob, "Verify schema matches the code");
  requireSuccessfulStep(
    stagingResetValidationJob,
    "Require exact staging revision and destructive confirmation",
  );
  requireSuccessfulStep(
    stagingResetJob,
    "Reject protected or mismatched staging project",
  );
  requireSuccessfulStep(stagingResetJob, "Verify database target identity");
  requireSuccessfulStep(
    stagingResetJob,
    "Reset every staging application table",
  );
  requireSuccessfulStep(
    stagingResetJob,
    "Seed repository-owned synthetic clinic",
  );
  requireSuccessfulStep(
    stagingResetJob,
    "Verify exact schema and migration history",
  );
  requireSuccessfulStep(
    stagingResetJob,
    "Prove synthetic-only staging data and contact boundaries",
  );
  requireSuccessfulStep(validationJob, "Require exact revision confirmation");
  requireSuccessfulStep(productionMigrationJob, "Apply migrations");
  requireSuccessfulStep(productionMigrationJob, "Re-apply row-level security");
  requireSuccessfulStep(
    productionMigrationJob,
    "Verify schema matches the code",
  );

  const stagingHealthBody = await boundedJsonResponse(
    stagingHealthResponse,
    "Staging health",
  );
  const healthBody = await boundedJsonResponse(
    healthResponse,
    "Production health",
  );
  const restoreDrill = regularBoundedJsonFile(
    options.restoreEvidencePath,
    "Restore evidence",
  );
  const restoreDecision = evaluateProviderRestoreReleaseEvidence(
    restoreDrill,
    Date.parse(checkedAt),
  );
  if (!restoreDecision.ready) {
    throw new Error(
      "Provider-restore evidence is incomplete, stale, or unsafe.",
    );
  }
  if (restoreDecision.releaseSha !== releaseSha) {
    throw new Error(
      "Provider-restore evidence does not match the release SHA.",
    );
  }
  if (restoreDecision.restoreTargetFingerprint !== stagingDatabaseFingerprint) {
    throw new Error(
      "Provider-restore evidence does not match the isolated staging database.",
    );
  }
  const incidentResponse = regularBoundedJsonFile(
    options.incidentEvidencePath,
    "Incident-response evidence",
  );
  const authRecovery = regularBoundedJsonFile(
    options.authRecoveryEvidencePath,
    "Account-recovery evidence",
  );
  const clinicPilot = regularBoundedJsonFile(
    options.clinicPilotEvidencePath,
    "Clinic-pilot evidence",
  );
  const clinicPilotProjection = regularBoundedJsonFile(
    options.clinicPilotProjectionAuditPath,
    "Clinic-pilot projection audit",
  );
  const clinicalDataIntegrity = {
    evidenceFormatVersion: 1,
    releaseSha,
    collectedAt: checkedAt,
    databaseTargetFingerprint: clinicalDatabaseFingerprint,
    audits: {
      controlledSubstances: regularBoundedJsonFile(
        options.controlledSubstanceAuditPath,
        "Controlled-substance audit evidence",
      ),
      prescriptions: regularBoundedJsonFile(
        options.prescriptionAuditPath,
        "Prescription audit evidence",
      ),
      labResults: regularBoundedJsonFile(
        options.labResultAuditPath,
        "Lab-result audit evidence",
      ),
      vaccinations: regularBoundedJsonFile(
        options.vaccinationAuditPath,
        "Vaccination audit evidence",
      ),
    },
  };
  if (
    !evaluateIncidentResponseEvidence(incidentResponse, Date.parse(checkedAt))
      .ready
  ) {
    throw new Error(
      "Incident-response evidence is incomplete, stale, or unsafe.",
    );
  }
  if (
    !evaluateAuthRecoveryEvidence(authRecovery, Date.parse(checkedAt)).ready
  ) {
    throw new Error(
      "Account-recovery evidence is incomplete, stale, or unsafe.",
    );
  }
  const clinicPilotDecision = evaluateClinicPilotReleaseEvidence(
    clinicPilot,
    Date.parse(checkedAt),
  );
  if (!clinicPilotDecision.ready) {
    throw new Error("Clinic-pilot evidence is incomplete, stale, or unsafe.");
  }
  if (clinicPilotDecision.releaseSha !== releaseSha) {
    throw new Error("Clinic-pilot evidence does not match the release SHA.");
  }
  const clinicPilotProjectionDecision = evaluateClinicPilotProjectionEvidence(
    clinicPilotProjection,
    Date.parse(checkedAt),
  );
  if (!clinicPilotProjectionDecision.ready) {
    throw new Error(
      "Clinic-pilot projection audit is incomplete, stale, or unsafe.",
    );
  }
  const clinicPilotRecord = record(clinicPilot);
  const clinicPilotSource = record(clinicPilotRecord?.sourceEvidence);
  const clinicPilotApprovals = record(clinicPilotRecord?.approvals);
  const clinicAdministratorApproval = record(
    clinicPilotApprovals?.clinicAdministrator,
  );
  const clinicAdministratorActorId =
    typeof clinicAdministratorApproval?.actorId === "string"
      ? clinicAdministratorApproval.actorId
      : null;
  if (
    clinicPilotProjectionDecision.clinicUseValidatedHash !==
      clinicPilotSource?.clinicUseValidatedHash ||
    clinicPilotProjectionDecision.pilotProjectionVersion !==
      clinicPilotSource?.pilotProjectionVersion ||
    clinicPilotProjectionDecision.databaseTargetFingerprint !==
      clinicalDatabaseFingerprint ||
    !clinicAdministratorActorId ||
    clinicPilotProjectionDecision.clinicAdministratorActorHash !==
      clinicPilotActorHash(clinicAdministratorActorId)
  ) {
    throw new Error(
      "Clinic-pilot packet does not match the configured immutable projection.",
    );
  }
  if (
    !evaluateClinicalDataIntegrityEvidence(
      clinicalDataIntegrity,
      Date.parse(checkedAt),
    ).ready
  ) {
    throw new Error(
      "Clinical-data integrity evidence is incomplete, stale, cross-target, or unsafe.",
    );
  }

  return {
    evidenceFormatVersion: 11,
    releaseSha,
    releaseApproval,
    ci: {
      releaseSha,
      repository: options.repository,
      ciRunId,
      ciRunUrl:
        typeof ci.run.html_url === "string" ? ci.run.html_url : undefined,
      migrationRunId,
      migrationRunUrl:
        typeof migration.run.html_url === "string"
          ? migration.run.html_url
          : undefined,
      gates: {
        migrations: "passed",
        rls: "passed",
        tests: "passed",
        build: "passed",
        dependencyAudit: "passed",
      },
    },
    repositoryGovernance,
    staging: {
      releaseSha,
      databaseTargetFingerprint: stagingDatabaseFingerprint,
      migrationRunId: stagingMigrationRunId,
      migrationRunUrl:
        typeof stagingMigration.run.html_url === "string"
          ? stagingMigration.run.html_url
          : undefined,
      resetRunId: stagingResetRunId,
      resetRunUrl:
        typeof stagingReset.run.html_url === "string"
          ? stagingReset.run.html_url
          : undefined,
      syntheticDataAudit: "passed",
      hostedHealth: {
        releaseSha,
        checkedAt,
        url: stagingHealthUrl.toString(),
        statusCode: stagingHealthResponse.status,
        body: stagingHealthBody,
      },
    },
    hostedHealth: {
      releaseSha,
      checkedAt,
      url: healthUrl.toString(),
      statusCode: healthResponse.status,
      body: healthBody,
    },
    incidentResponse,
    authRecovery,
    clinicPilot,
    clinicPilotProjection,
    clinicalDataIntegrity,
    restoreDrill,
  };
}
