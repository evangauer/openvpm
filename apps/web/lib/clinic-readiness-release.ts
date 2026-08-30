import { evaluateIncidentResponseEvidence } from "./incident-response-evidence";
import { evaluateAuthRecoveryEvidence } from "./auth-recovery-evidence";
import { evaluateClinicalDataIntegrityEvidence } from "./clinical-data-integrity-evidence";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HEALTH_MAX_AGE_MS = 15 * 60 * 1000;
const RESTORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REQUIRED_MAIN_CHECKS = [
  "build",
  "Golden clinic workflow",
  "Migration history integrity",
  "RLS tenant isolation",
  "Analyze (actions)",
  "Analyze (javascript-typescript)",
  "Disposable restore drill",
] as const;

export const REQUIRED_RELEASE_CI_GATES = [
  "migrations",
  "rls",
  "tests",
  "build",
  "dependencyAudit",
] as const;

const REQUIRED_HOSTED_CHECKS = [
  "hostedRelease",
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
] as const;

type RecordValue = Record<string, unknown>;

export type ClinicReadinessDecision = {
  decision: "GO" | "NO_GO";
  releaseSha: string | null;
  evaluatedAt: string;
  reasons: string[];
};

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireFreshTimestamp(
  reasons: string[],
  label: string,
  value: unknown,
  nowMs: number,
  maxAgeMs: number,
) {
  const parsed = timestamp(value);
  if (parsed == null) {
    reasons.push(`${label} timestamp is missing or invalid.`);
    return;
  }
  if (parsed > nowMs + 60_000) {
    reasons.push(`${label} timestamp is in the future.`);
  } else if (nowMs - parsed > maxAgeMs) {
    reasons.push(`${label} evidence is stale.`);
  }
}

function evaluateHostedHealthEvidence(
  reasons: string[],
  label: "Hosted" | "Staging hosted",
  value: unknown,
  releaseSha: string | null,
  nowMs: number,
) {
  const hosted = record(value);
  if (!hosted) {
    reasons.push(`${label} health evidence is missing.`);
    return;
  }
  if (releaseSha && hosted.releaseSha !== releaseSha) {
    reasons.push(`${label} health does not match the release SHA.`);
  }
  requireFreshTimestamp(
    reasons,
    `${label} health`,
    hosted.checkedAt,
    nowMs,
    HEALTH_MAX_AGE_MS,
  );
  if (hosted.statusCode !== 200) {
    reasons.push(`${label} health did not return HTTP 200.`);
  }
  const body = record(hosted.body);
  if (body?.ok !== true || body?.mode !== "hosted") {
    reasons.push(
      `${label} health is not an affirmative hosted readiness result.`,
    );
  }
  if (releaseSha && body?.releaseSha !== releaseSha) {
    reasons.push(`${label} health body does not identify the release SHA.`);
  }
  const checks = record(body?.checks);
  for (const checkName of REQUIRED_HOSTED_CHECKS) {
    const check = record(checks?.[checkName]);
    if (check?.ok !== true) {
      reasons.push(`${label} check ${checkName} is missing or unhealthy.`);
    }
    if (check?.advisory === true) {
      reasons.push(`${label} check ${checkName} is still advisory.`);
    }
  }
  if (checks) {
    for (const [name, checkValue] of Object.entries(checks)) {
      const check = record(checkValue);
      if (check && check.advisory !== true && check.ok !== true) {
        reasons.push(`${label} release-blocking check ${name} is unhealthy.`);
      }
    }
  }
}

export function evaluateClinicReadinessRelease(
  input: unknown,
  nowMs = Date.now(),
): ClinicReadinessDecision {
  const reasons: string[] = [];
  const root = record(input);
  if (root?.evidenceFormatVersion !== 6) {
    reasons.push("Clinic readiness evidence format version must be 6.");
  }
  const releaseSha =
    root &&
    typeof root.releaseSha === "string" &&
    SHA_PATTERN.test(root.releaseSha)
      ? root.releaseSha.toLowerCase()
      : null;
  if (!releaseSha)
    reasons.push("Release SHA must be an exact 40-character commit.");

  const clinicalDataIntegrity = record(root?.clinicalDataIntegrity);
  if (!clinicalDataIntegrity) {
    reasons.push("Clinical-data integrity evidence is missing.");
  } else {
    const clinicalDecision = evaluateClinicalDataIntegrityEvidence(
      clinicalDataIntegrity,
      nowMs,
    );
    reasons.push(...clinicalDecision.reasons);
    if (releaseSha && clinicalDecision.releaseSha !== releaseSha) {
      reasons.push(
        "Clinical-data integrity evidence does not match the release SHA.",
      );
    }
  }

  const ci = record(root?.ci);
  if (!ci) {
    reasons.push("CI evidence is missing.");
  } else {
    if (releaseSha && ci.releaseSha !== releaseSha) {
      reasons.push("CI evidence does not match the release SHA.");
    }
    const gates = record(ci.gates);
    for (const gate of REQUIRED_RELEASE_CI_GATES) {
      if (gates?.[gate] !== "passed") {
        reasons.push(`CI gate ${gate} has not passed.`);
      }
    }
  }

  const incidentResponse = record(root?.incidentResponse);
  if (!incidentResponse) {
    reasons.push("Incident-response evidence is missing.");
  } else {
    const incidentDecision = evaluateIncidentResponseEvidence(
      incidentResponse,
      nowMs,
    );
    reasons.push(...incidentDecision.reasons);
  }

  const authRecovery = record(root?.authRecovery);
  if (!authRecovery) {
    reasons.push("Account-recovery evidence is missing.");
  } else {
    const authRecoveryDecision = evaluateAuthRecoveryEvidence(
      authRecovery,
      nowMs,
    );
    reasons.push(...authRecoveryDecision.reasons);
  }

  const governance = record(root?.repositoryGovernance);
  if (!governance) {
    reasons.push("Repository governance evidence is missing.");
  } else {
    requireFreshTimestamp(
      reasons,
      "Repository governance",
      governance.checkedAt,
      nowMs,
      HEALTH_MAX_AGE_MS,
    );
    const environment = record(governance.productionEnvironment);
    if (!environment) {
      reasons.push("Production environment governance is missing.");
    } else {
      if (environment.exists !== true) {
        reasons.push("Production environment is missing.");
      }
      if (environment.canAdminsBypass !== false) {
        reasons.push("Production environment allows administrator bypass.");
      }
      if (environment.preventSelfReview !== true) {
        reasons.push("Production environment does not prevent self-review.");
      }
      if (
        typeof environment.requiredReviewerCount !== "number" ||
        environment.requiredReviewerCount < 1
      ) {
        reasons.push("Production environment has no required reviewer.");
      }
      if (
        environment.usesCustomBranchPolicies !== true ||
        environment.mainOnlyBranchPolicy !== true
      ) {
        reasons.push("Production environment is not restricted to main.");
      }
    }

    const stagingEnvironment = record(governance.stagingEnvironment);
    if (!stagingEnvironment) {
      reasons.push("Staging environment governance is missing.");
    } else {
      if (stagingEnvironment.exists !== true) {
        reasons.push("Staging environment is missing.");
      }
      if (stagingEnvironment.canAdminsBypass !== false) {
        reasons.push("Staging environment allows administrator bypass.");
      }
      if (stagingEnvironment.preventSelfReview !== true) {
        reasons.push("Staging environment does not prevent self-review.");
      }
      if (
        typeof stagingEnvironment.requiredReviewerCount !== "number" ||
        stagingEnvironment.requiredReviewerCount < 1
      ) {
        reasons.push("Staging environment has no required reviewer.");
      }
      if (
        stagingEnvironment.usesCustomBranchPolicies !== true ||
        stagingEnvironment.stagingOnlyBranchPolicy !== true
      ) {
        reasons.push("Staging environment is not restricted to staging.");
      }
    }

    const main = record(governance.mainBranch);
    if (!main) {
      reasons.push("Main branch governance is missing.");
    } else {
      if (main.enforceAdmins !== true) {
        reasons.push(
          "Main branch protection does not apply to administrators.",
        );
      }
      if (main.strictStatusChecks !== true) {
        reasons.push("Main branch does not require strict status checks.");
      }
      const requiredChecks = Array.isArray(main.requiredChecks)
        ? new Set(
            main.requiredChecks.filter((item) => typeof item === "string"),
          )
        : new Set<string>();
      for (const check of REQUIRED_MAIN_CHECKS) {
        if (!requiredChecks.has(check)) {
          reasons.push(`Main branch does not require ${check}.`);
        }
      }
      if (
        typeof main.requiredApprovalCount !== "number" ||
        main.requiredApprovalCount < 2
      ) {
        reasons.push("Main branch requires fewer than two approvals.");
      }
      if (main.dismissStaleReviews !== true) {
        reasons.push("Main branch does not dismiss stale approvals.");
      }
      if (main.requireCodeOwnerReviews !== true) {
        reasons.push("Main branch does not require code-owner review.");
      }
      if (main.requireLastPushApproval !== true) {
        reasons.push(
          "Main branch does not require approval after the last push.",
        );
      }
      if (main.requireConversationResolution !== true) {
        reasons.push("Main branch does not require conversation resolution.");
      }
      if (main.allowForcePushes !== false) {
        reasons.push("Main branch allows force pushes.");
      }
      if (main.allowDeletions !== false) {
        reasons.push("Main branch allows deletion.");
      }
    }

    const stagingBranch = record(governance.stagingBranch);
    if (!stagingBranch) {
      reasons.push("Staging branch governance is missing.");
    } else {
      if (stagingBranch.enforceAdmins !== true) {
        reasons.push(
          "Staging branch protection does not apply to administrators.",
        );
      }
      if (stagingBranch.strictStatusChecks !== true) {
        reasons.push("Staging branch does not require strict status checks.");
      }
      const stagingChecks = Array.isArray(stagingBranch.requiredChecks)
        ? new Set(
            stagingBranch.requiredChecks.filter(
              (item) => typeof item === "string",
            ),
          )
        : new Set<string>();
      for (const check of REQUIRED_MAIN_CHECKS) {
        if (!stagingChecks.has(check)) {
          reasons.push(`Staging branch does not require ${check}.`);
        }
      }
      if (
        typeof stagingBranch.requiredApprovalCount !== "number" ||
        stagingBranch.requiredApprovalCount < 1
      ) {
        reasons.push("Staging branch requires no approval.");
      }
      if (stagingBranch.dismissStaleReviews !== true) {
        reasons.push("Staging branch does not dismiss stale approvals.");
      }
      if (stagingBranch.requireCodeOwnerReviews !== true) {
        reasons.push("Staging branch does not require code-owner review.");
      }
      if (stagingBranch.requireLastPushApproval !== true) {
        reasons.push(
          "Staging branch does not require approval after the last push.",
        );
      }
      if (stagingBranch.requireConversationResolution !== true) {
        reasons.push(
          "Staging branch does not require conversation resolution.",
        );
      }
      if (stagingBranch.allowForcePushes !== false) {
        reasons.push("Staging branch allows force pushes.");
      }
      if (stagingBranch.allowDeletions !== false) {
        reasons.push("Staging branch allows deletion.");
      }
    }
  }

  const staging = record(root?.staging);
  if (!staging) {
    reasons.push("Isolated staging evidence is missing.");
  } else {
    if (releaseSha && staging.releaseSha !== releaseSha) {
      reasons.push(
        "Isolated staging migration does not match the release SHA.",
      );
    }
    if (
      typeof staging.migrationRunId !== "number" ||
      !Number.isSafeInteger(staging.migrationRunId) ||
      staging.migrationRunId <= 0
    ) {
      reasons.push("Isolated staging migration run ID is missing or invalid.");
    }
    evaluateHostedHealthEvidence(
      reasons,
      "Staging hosted",
      staging.hostedHealth,
      releaseSha,
      nowMs,
    );
  }

  evaluateHostedHealthEvidence(
    reasons,
    "Hosted",
    root?.hostedHealth,
    releaseSha,
    nowMs,
  );

  const restore = record(root?.restoreDrill);
  if (!restore) {
    reasons.push("Restore drill evidence is missing.");
  } else {
    if (releaseSha && restore.releaseSha !== releaseSha) {
      reasons.push("Restore drill does not match the release SHA.");
    }
    requireFreshTimestamp(
      reasons,
      "Restore drill",
      restore.completedAt,
      nowMs,
      RESTORE_MAX_AGE_MS,
    );
    if (restore.status !== "passed") {
      reasons.push("Restore drill has not passed.");
    }
    if (restore.synthetic !== false) {
      reasons.push(
        "A provider-backed non-synthetic restore drill is required.",
      );
    }
    const recoveryHold = record(restore.recoveryHold);
    if (
      recoveryHold?.observedBeforeReconciliation !== true ||
      recoveryHold?.releasedAfterChecklistAndDatabaseGate !== true
    ) {
      reasons.push("Restore recovery-hold evidence is incomplete.");
    }
    const object = record(restore.independentObject);
    if (
      object?.exactVersionVerified !== true ||
      typeof object.objectVersionId !== "string" ||
      !object.objectVersionId.trim() ||
      typeof object.checksumSha256 !== "string" ||
      !/^[0-9a-f]{64}$/i.test(object.checksumSha256) ||
      typeof object.fileSizeBytes !== "number" ||
      object.fileSizeBytes < 0
    ) {
      reasons.push("Independent object restore evidence is incomplete.");
    }
    const smoke = record(restore.smoke);
    if (
      smoke?.authenticationResetRequired !== true ||
      smoke?.tenantIsolation !== true ||
      ![
        "schedulingRows",
        "clinicalRows",
        "invoiceRows",
        "paymentRows",
        "fileAccessRows",
      ].every((name) => typeof smoke?.[name] === "number" && smoke[name] > 0)
    ) {
      reasons.push(
        "Post-restore clinic workflow smoke evidence is incomplete.",
      );
    }
  }

  return {
    decision: reasons.length === 0 ? "GO" : "NO_GO",
    releaseSha,
    evaluatedAt: new Date(nowMs).toISOString(),
    reasons: [...new Set(reasons)],
  };
}
