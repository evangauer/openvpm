import { AUTH_RECOVERY_POLICY_VERSION } from "./auth-recovery-readiness";

const MAX_EVIDENCE_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const MIN_DRILL_DURATION_MS = 15 * 60 * 1_000;
const MAX_DRILL_DURATION_MS = 4 * 60 * 60 * 1_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DRILL_ID = /^auth-recovery-(\d{4}-\d{2}-\d{2})-[a-f0-9]{8}$/;
const SAFE_HANDLE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,36}[A-Za-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export const AUTH_RECOVERY_DRILL_CONTROLS = [
  "approvalRecordedBeforeExecution",
  "auditTrailVerified",
  "emailOnlyRecoveryRejected",
  "identityProofingRecorded",
  "passwordOnlyRecoveryRejected",
  "priorPasskeysRetired",
  "priorSessionsRevoked",
  "recoveryGrantExpired",
  "recoveryGrantSingleUse",
  "requestRecorded",
  "twoPasskeysReenrolled",
] as const;

const ROOT_KEYS = [
  "authorities",
  "completedAt",
  "controls",
  "drillId",
  "evidenceFormatVersion",
  "evidenceSafety",
  "findings",
  "operators",
  "policy",
  "startedAt",
] as const;
const POLICY_KEYS = ["approvedAt", "approvedBy", "sha256", "version"] as const;
const OPERATOR_KEYS = ["approver", "requester"] as const;
const SAFETY_KEYS = [
  "emailAddressesFree",
  "localPathsFree",
  "phiFree",
  "secretsFree",
] as const;
const FINDING_KEYS = [
  "criticalCount",
  "followUpIssueNumbers",
  "highCount",
] as const;

type RecordValue = Record<string, unknown>;

export type AuthRecoveryEvidenceDecision = {
  ready: boolean;
  drillId: string | null;
  evaluatedAt: string;
  reasons: string[];
};

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function safeHandle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_HANDLE.test(value) &&
    !/^@(unassigned|unknown|replace|todo|tbd)(?:-|$)/i.test(value)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Strict, free-form-text-free release evidence for a real recovery drill. */
export function evaluateAuthRecoveryEvidence(
  input: unknown,
  nowMs = Date.now(),
): AuthRecoveryEvidenceDecision {
  const reasons: string[] = [];
  const root = record(input);
  if (!root || !exactKeys(root, ROOT_KEYS)) {
    reasons.push("Account-recovery evidence has an unexpected root shape.");
  }
  if (root?.evidenceFormatVersion !== 1) {
    reasons.push("Account-recovery evidence format version must be 1.");
  }

  const drillMatch =
    typeof root?.drillId === "string" ? DRILL_ID.exec(root.drillId) : null;
  const drillId = drillMatch ? (root?.drillId as string) : null;
  if (!drillId) reasons.push("Account-recovery drill ID is invalid.");

  const startedAt = timestamp(root?.startedAt);
  const completedAt = timestamp(root?.completedAt);
  if (startedAt == null || completedAt == null) {
    reasons.push("Account-recovery drill timestamps are missing or invalid.");
  } else {
    const duration = completedAt - startedAt;
    if (
      duration < MIN_DRILL_DURATION_MS ||
      duration > MAX_DRILL_DURATION_MS
    ) {
      reasons.push("Account-recovery drill duration is outside policy.");
    }
    if (completedAt > nowMs + 60_000) {
      reasons.push("Account-recovery evidence is dated in the future.");
    } else if (nowMs - completedAt > MAX_EVIDENCE_AGE_MS) {
      reasons.push("Account-recovery evidence is older than 90 days.");
    }
    if (
      drillMatch &&
      drillMatch[1] !== new Date(completedAt).toISOString().slice(0, 10)
    ) {
      reasons.push("Account-recovery drill ID date does not match completion.");
    }
  }

  const policy = record(root?.policy);
  if (!policy || !exactKeys(policy, POLICY_KEYS)) {
    reasons.push("Account-recovery policy evidence is malformed.");
  } else {
    if (
      policy.version !== AUTH_RECOVERY_POLICY_VERSION ||
      typeof policy.sha256 !== "string" ||
      !SHA256.test(policy.sha256)
    ) {
      reasons.push("Account-recovery policy is not approved and pinned.");
    }
    const approvedAt = timestamp(policy.approvedAt);
    if (!safeHandle(policy.approvedBy)) {
      reasons.push("Account-recovery policy approver is not assigned.");
    }
    if (
      approvedAt == null ||
      startedAt == null ||
      approvedAt > startedAt ||
      approvedAt > nowMs + 60_000
    ) {
      reasons.push("Account-recovery policy approval time is invalid.");
    }
  }

  const authorityValues = root?.authorities;
  const authorities = Array.isArray(authorityValues)
    ? authorityValues.filter(safeHandle).map((value) => value.toLowerCase())
    : [];
  if (
    !Array.isArray(authorityValues) ||
    authorityValues.length < 2 ||
    authorityValues.length > 5 ||
    authorities.length !== authorityValues.length ||
    new Set(authorities).size !== authorities.length
  ) {
    reasons.push(
      "Account-recovery authorities must name two to five distinct people.",
    );
  }

  const operators = record(root?.operators);
  if (!operators || !exactKeys(operators, OPERATOR_KEYS)) {
    reasons.push("Account-recovery drill operators are malformed.");
  } else {
    const requester = safeHandle(operators.requester)
      ? operators.requester.toLowerCase()
      : null;
    const approver = safeHandle(operators.approver)
      ? operators.approver.toLowerCase()
      : null;
    if (
      !requester ||
      !approver ||
      requester === approver ||
      !authorities.includes(requester) ||
      !authorities.includes(approver)
    ) {
      reasons.push(
        "Account-recovery request and approval require distinct named authorities.",
      );
    }
  }

  const controls = record(root?.controls);
  if (!controls || !exactKeys(controls, AUTH_RECOVERY_DRILL_CONTROLS)) {
    reasons.push("Account-recovery drill controls are malformed.");
  } else {
    for (const control of AUTH_RECOVERY_DRILL_CONTROLS) {
      if (controls[control] !== true) {
        reasons.push(`Account-recovery drill did not prove ${control}.`);
      }
    }
  }

  const safety = record(root?.evidenceSafety);
  if (!safety || !exactKeys(safety, SAFETY_KEYS)) {
    reasons.push("Account-recovery evidence safety attestation is malformed.");
  } else {
    for (const field of SAFETY_KEYS) {
      if (safety[field] !== true) {
        reasons.push(`Account-recovery evidence is not ${field}.`);
      }
    }
  }

  const findings = record(root?.findings);
  if (!findings || !exactKeys(findings, FINDING_KEYS)) {
    reasons.push("Account-recovery follow-up summary is malformed.");
  } else {
    if (!nonNegativeInteger(findings.criticalCount)) {
      reasons.push("Account-recovery critical finding count is invalid.");
    }
    if (!nonNegativeInteger(findings.highCount)) {
      reasons.push("Account-recovery high finding count is invalid.");
    }
    const issues = findings.followUpIssueNumbers;
    if (
      !Array.isArray(issues) ||
      issues.some(
        (item) => !Number.isSafeInteger(item) || Number(item) <= 0,
      ) ||
      new Set(issues).size !== issues.length
    ) {
      reasons.push("Account-recovery follow-up issue numbers are invalid.");
    } else if (
      nonNegativeInteger(findings.criticalCount) &&
      nonNegativeInteger(findings.highCount) &&
      findings.criticalCount + findings.highCount > 0 &&
      issues.length === 0
    ) {
      reasons.push(
        "Account-recovery critical/high findings require a follow-up issue.",
      );
    }
  }

  return {
    ready: reasons.length === 0,
    drillId,
    evaluatedAt: new Date(nowMs).toISOString(),
    reasons,
  };
}
