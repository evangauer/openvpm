const MAX_EVIDENCE_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const MIN_EXERCISE_DURATION_MS = 15 * 60 * 1000;
const MAX_EXERCISE_DURATION_MS = 8 * 60 * 60 * 1000;
const MAX_APPROVAL_LAG_MS = 7 * 24 * 60 * 60 * 1000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXERCISE_ID = /^tabletop-(\d{4}-\d{2}-\d{2})-[a-f0-9]{8}$/;
const GITHUB_HANDLE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,36}[A-Za-z0-9])?$/;

export const INCIDENT_RESPONSE_ROLES = [
  "incidentCommander",
  "privacyLegalReviewer",
  "notificationAuthority",
] as const;

export const INCIDENT_RESPONSE_SCENARIOS = [
  "database",
  "objectStore",
  "stripe",
  "emailProvider",
  "credentialCompromise",
] as const;

const ROOT_KEYS = [
  "approvals",
  "completedAt",
  "evidenceFormatVersion",
  "evidenceSafety",
  "exerciseId",
  "exerciseType",
  "findings",
  "roles",
  "scenarios",
  "startedAt",
] as const;
const SCENARIO_KEYS = [
  "clinicNotificationDecisionRecorded",
  "containment",
  "detection",
  "evidenceHandling",
  "legalNotificationDecisionRecorded",
  "recovery",
  "status",
  "vendorCoordination",
] as const;
const SAFETY_KEYS = [
  "localPathsFree",
  "phiFree",
  "providerPayloadsFree",
  "secretsFree",
] as const;
const FINDING_KEYS = [
  "criticalCount",
  "followUpIssueNumbers",
  "highCount",
] as const;
const APPROVAL_KEYS = ["approvedAt", "approver"] as const;

type RecordValue = Record<string, unknown>;

export type IncidentResponseEvidenceDecision = {
  ready: boolean;
  exerciseId: string | null;
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
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? parsed : null;
}

function safeHandle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    GITHUB_HANDLE.test(value) &&
    !/^@(unassigned|unknown|replace|todo|tbd)(?:-|$)/i.test(value)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function evaluateIncidentResponseEvidence(
  input: unknown,
  nowMs = Date.now(),
): IncidentResponseEvidenceDecision {
  const reasons: string[] = [];
  const root = record(input);
  if (!root || !exactKeys(root, ROOT_KEYS)) {
    reasons.push("Incident-response evidence has an unexpected root shape.");
  }
  if (root?.evidenceFormatVersion !== 1) {
    reasons.push("Incident-response evidence format version must be 1.");
  }
  if (root?.exerciseType !== "tabletop") {
    reasons.push(
      "Incident-response evidence must describe a tabletop exercise.",
    );
  }
  const exerciseIdMatch =
    typeof root?.exerciseId === "string"
      ? EXERCISE_ID.exec(root.exerciseId)
      : null;
  const exerciseId = exerciseIdMatch ? (root?.exerciseId as string) : null;
  if (!exerciseId) reasons.push("Incident-response exercise ID is invalid.");

  const startedAt = timestamp(root?.startedAt);
  const completedAt = timestamp(root?.completedAt);
  if (startedAt == null || completedAt == null) {
    reasons.push(
      "Incident-response exercise timestamps are missing or invalid.",
    );
  } else {
    const duration = completedAt - startedAt;
    if (
      duration < MIN_EXERCISE_DURATION_MS ||
      duration > MAX_EXERCISE_DURATION_MS
    ) {
      reasons.push("Incident-response exercise duration is outside policy.");
    }
    if (completedAt > nowMs + 60_000) {
      reasons.push("Incident-response evidence is dated in the future.");
    } else if (nowMs - completedAt > MAX_EVIDENCE_AGE_MS) {
      reasons.push("Incident-response evidence is older than 180 days.");
    }
    if (
      exerciseIdMatch &&
      exerciseIdMatch[1] !== new Date(completedAt).toISOString().slice(0, 10)
    ) {
      reasons.push(
        "Incident-response exercise ID date does not match completion.",
      );
    }
  }

  const roles = record(root?.roles);
  const roleHandles = new Map<string, string>();
  if (!roles || !exactKeys(roles, INCIDENT_RESPONSE_ROLES)) {
    reasons.push("Incident-response roles are missing or unexpected.");
  } else {
    for (const role of INCIDENT_RESPONSE_ROLES) {
      const handle = roles[role];
      if (!safeHandle(handle)) {
        reasons.push(`Incident-response role ${role} is not assigned.`);
      } else {
        roleHandles.set(role, handle.toLowerCase());
      }
    }
    if (new Set(roleHandles.values()).size !== INCIDENT_RESPONSE_ROLES.length) {
      reasons.push(
        "Incident-response roles must be assigned to distinct people.",
      );
    }
  }

  const approvals = record(root?.approvals);
  if (!approvals || !exactKeys(approvals, INCIDENT_RESPONSE_ROLES)) {
    reasons.push("Incident-response approvals are missing or unexpected.");
  } else {
    for (const role of INCIDENT_RESPONSE_ROLES) {
      const approval = record(approvals[role]);
      const approvedAt = timestamp(approval?.approvedAt);
      if (!approval || !exactKeys(approval, APPROVAL_KEYS)) {
        reasons.push(`Incident-response approval ${role} is malformed.`);
        continue;
      }
      if (
        !safeHandle(approval.approver) ||
        approval.approver.toLowerCase() !== roleHandles.get(role)
      ) {
        reasons.push(
          `Incident-response approval ${role} has the wrong approver.`,
        );
      }
      if (
        approvedAt == null ||
        startedAt == null ||
        completedAt == null ||
        approvedAt < completedAt ||
        approvedAt > completedAt + MAX_APPROVAL_LAG_MS ||
        approvedAt > nowMs + 60_000
      ) {
        reasons.push(`Incident-response approval ${role} has an invalid time.`);
      }
    }
  }

  const scenarios = record(root?.scenarios);
  if (!scenarios || !exactKeys(scenarios, INCIDENT_RESPONSE_SCENARIOS)) {
    reasons.push("Incident-response scenarios are missing or unexpected.");
  } else {
    for (const scenarioName of INCIDENT_RESPONSE_SCENARIOS) {
      const scenario = record(scenarios[scenarioName]);
      if (!scenario || !exactKeys(scenario, SCENARIO_KEYS)) {
        reasons.push(
          `Incident-response scenario ${scenarioName} is malformed.`,
        );
        continue;
      }
      if (scenario.status !== "passed") {
        reasons.push(
          `Incident-response scenario ${scenarioName} has not passed.`,
        );
      }
      for (const field of SCENARIO_KEYS.filter((item) => item !== "status")) {
        if (scenario[field] !== true) {
          reasons.push(
            `Incident-response scenario ${scenarioName} is missing ${field}.`,
          );
        }
      }
    }
  }

  const safety = record(root?.evidenceSafety);
  if (!safety || !exactKeys(safety, SAFETY_KEYS)) {
    reasons.push("Incident-response evidence safety attestation is malformed.");
  } else {
    for (const field of SAFETY_KEYS) {
      if (safety[field] !== true) {
        reasons.push(`Incident-response evidence is not ${field}.`);
      }
    }
  }

  const findings = record(root?.findings);
  if (!findings || !exactKeys(findings, FINDING_KEYS)) {
    reasons.push("Incident-response follow-up summary is malformed.");
  } else {
    if (!nonNegativeInteger(findings.criticalCount)) {
      reasons.push("Incident-response critical finding count is invalid.");
    }
    if (!nonNegativeInteger(findings.highCount)) {
      reasons.push("Incident-response high finding count is invalid.");
    }
    const issueNumbers = findings.followUpIssueNumbers;
    if (
      !Array.isArray(issueNumbers) ||
      issueNumbers.some(
        (item) => !Number.isSafeInteger(item) || Number(item) <= 0,
      ) ||
      new Set(issueNumbers).size !== issueNumbers.length
    ) {
      reasons.push("Incident-response follow-up issue numbers are invalid.");
    } else if (
      nonNegativeInteger(findings.criticalCount) &&
      nonNegativeInteger(findings.highCount) &&
      findings.criticalCount + findings.highCount > 0 &&
      issueNumbers.length === 0
    ) {
      reasons.push(
        "Incident-response critical/high findings require a follow-up issue.",
      );
    }
  }

  return {
    ready: reasons.length === 0,
    exerciseId,
    evaluatedAt: new Date(nowMs).toISOString(),
    reasons,
  };
}
