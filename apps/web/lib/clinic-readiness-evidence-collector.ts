import { readFileSync, statSync } from "node:fs";

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

export type ClinicReadinessEvidenceCollectionOptions = {
  releaseSha: string;
  repository: string;
  ciRunId: number;
  migrationRunId: number;
  hostedHealthUrl: string;
  restoreEvidencePath: string;
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

function runId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function regularBoundedJsonFile(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Restore evidence must be a regular file.");
  if (stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error("Restore evidence exceeds the 1 MB safety limit.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
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
    ? job.steps.filter(
        (value): value is WorkflowStep =>
          Boolean(value && typeof value === "object" && !Array.isArray(value)),
      )
    : [];
  const matches = steps.filter((step) => step.name === name);
  if (matches.length !== 1) {
    throw new Error(`GitHub job ${String(job.name)} must contain step ${name}.`);
  }
  if (matches[0].status !== "completed" || matches[0].conclusion !== "success") {
    throw new Error(`GitHub step ${String(job.name)} / ${name} has not passed.`);
  }
}

function verifyRun(
  run: WorkflowRun,
  expected: {
    label: string;
    name: string;
    event: string;
    releaseSha: string;
  },
) {
  if (
    run.name !== expected.name ||
    run.event !== expected.event ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_branch !== "main" ||
    typeof run.head_sha !== "string" ||
    run.head_sha.toLowerCase() !== expected.releaseSha
  ) {
    throw new Error(
      `${expected.label} must be a successful exact-SHA ${expected.name} run from main.`,
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
  if (!jobsResponse || typeof jobsResponse !== "object" || Array.isArray(jobsResponse)) {
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
  if (!REPOSITORY_PATTERN.test(options.repository)) {
    throw new Error("GitHub repository must use the owner/name form.");
  }
  const ciRunId = runId(options.ciRunId, "CI run ID");
  const migrationRunId = runId(options.migrationRunId, "Migration run ID");
  const healthUrl = hostedHealthEndpoint(options.hostedHealthUrl);
  const fetchFn = options.fetchFn ?? fetch;

  const [ci, migration, healthResponse] = await Promise.all([
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
      migrationRunId,
      options.githubToken,
      "Production migration",
    ),
    fetchFn(healthUrl, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }),
  ]);

  verifyRun(ci.run, {
    label: "CI",
    name: "CI",
    event: "push",
    releaseSha,
  });
  verifyRun(migration.run, {
    label: "Production migration",
    name: "Apply migrations",
    event: "workflow_dispatch",
    releaseSha,
  });

  const buildJob = successfulJob(ci.jobs, "build");
  const goldenJob = successfulJob(ci.jobs, "Golden clinic workflow");
  const migrationIntegrityJob = successfulJob(
    ci.jobs,
    "Migration history integrity",
  );
  const rlsJob = successfulJob(ci.jobs, "RLS tenant isolation");
  const validationJob = successfulJob(
    migration.jobs,
    "validate production request",
  );
  const productionMigrationJob = successfulJob(migration.jobs, "production");

  requireSuccessfulStep(buildJob, "Audit production dependencies");
  requireSuccessfulStep(buildJob, "Run pnpm test");
  requireSuccessfulStep(buildJob, "Run pnpm build");
  requireSuccessfulStep(goldenJob, "Prove the multi-clinic golden workflow");
  requireSuccessfulStep(
    migrationIntegrityJob,
    "Verify append-only migration history",
  );
  requireSuccessfulStep(rlsJob, "Prove tenant/RLS pool-reuse isolation");
  requireSuccessfulStep(validationJob, "Require exact revision confirmation");
  requireSuccessfulStep(productionMigrationJob, "Apply migrations");
  requireSuccessfulStep(productionMigrationJob, "Re-apply row-level security");
  requireSuccessfulStep(productionMigrationJob, "Verify schema matches the code");

  const healthBody = await boundedJsonResponse(healthResponse, "Hosted health");
  const restoreDrill = regularBoundedJsonFile(options.restoreEvidencePath);
  const checkedAt = (options.now ?? new Date()).toISOString();

  return {
    evidenceFormatVersion: 1,
    releaseSha,
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
    hostedHealth: {
      releaseSha,
      checkedAt,
      url: healthUrl.toString(),
      statusCode: healthResponse.status,
      body: healthBody,
    },
    restoreDrill,
  };
}
