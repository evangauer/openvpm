const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_PILOT_DURATION_MS = 4 * 24 * 60 * 60 * 1_000;
const MAX_PILOT_DURATION_MS = 45 * 24 * 60 * 60 * 1_000;
const MAX_APPROVAL_LAG_MS = 7 * 24 * 60 * 60 * 1_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PILOT_ID = /^pilot-(\d{4}-\d{2}-\d{2})-[a-f0-9]{8}$/;
const SHA = /^[0-9a-f]{40}$/i;
const USER_ACTOR =
  /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GITHUB_ACTOR = /^github:@[A-Za-z0-9](?:[A-Za-z0-9-]{0,36}[A-Za-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export const CLINIC_PILOT_APPROVAL_ROLES = [
  "clinicAdministrator",
  "veterinaryClinicalOwner",
  "releaseOwner",
  "securityOwner",
] as const;

export const CLINIC_PILOT_OUTCOMES = [
  "clinicAcceptanceRecorded",
  "clinicUseValidated",
  "communicationTested",
  "exportAndRollbackConfirmed",
  "firstVisitValidated",
  "hostedFullAccess",
  "incidentAndDowntimeProcedureExercised",
  "parallelPimsRetained",
  "paymentMethodCollected",
  "setupComplete",
  "verifiedAdministrator",
] as const;

const ROOT_KEYS = [
  "approvals",
  "completedAt",
  "evidenceFormatVersion",
  "evidenceSafety",
  "findings",
  "outcomes",
  "pilotId",
  "pilotScope",
  "releaseSha",
  "sourceEvidence",
  "startedAt",
] as const;
const PILOT_SCOPE_KEYS = [
  "activeLocationCount",
  "distinctClinicDays",
  "jurisdiction",
  "workflow",
] as const;
const APPROVAL_KEYS = ["actorId", "approvedAt"] as const;
const SAFETY_KEYS = [
  "contactDestinationsFree",
  "localPathsFree",
  "patientIdentifiersFree",
  "phiFree",
  "secretsFree",
] as const;
const FINDING_KEYS = [
  "criticalCount",
  "highCount",
  "openReleaseBlockingCount",
] as const;
const SOURCE_EVIDENCE_KEYS = [
  "clinicUseValidatedHash",
  "pilotProjectionVersion",
] as const;

type RecordValue = Record<string, unknown>;

export type ClinicPilotReleaseEvidenceDecision = {
  ready: boolean;
  pilotId: string | null;
  releaseSha: string | null;
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

function actorId(value: unknown, role: string): string | null {
  if (typeof value !== "string") return null;
  if (role === "clinicAdministrator") {
    return USER_ACTOR.test(value) ? value.toLowerCase() : null;
  }
  return GITHUB_ACTOR.test(value) &&
    !/^github:@(?:unassigned|unknown|replace|todo|tbd)(?:-|$)/i.test(value)
    ? value.toLowerCase()
    : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Strict, free-form-text-free evidence for a completed controlled clinic pilot. */
export function evaluateClinicPilotReleaseEvidence(
  input: unknown,
  nowMs = Date.now(),
): ClinicPilotReleaseEvidenceDecision {
  const reasons: string[] = [];
  const root = record(input);
  if (!root || !exactKeys(root, ROOT_KEYS)) {
    reasons.push("Clinic-pilot evidence has an unexpected root shape.");
  }
  if (root?.evidenceFormatVersion !== 1) {
    reasons.push("Clinic-pilot evidence format version must be 1.");
  }

  const pilotMatch =
    typeof root?.pilotId === "string" ? PILOT_ID.exec(root.pilotId) : null;
  const pilotId = pilotMatch ? (root?.pilotId as string) : null;
  if (!pilotId) reasons.push("Clinic-pilot evidence ID is invalid.");

  const releaseSha =
    typeof root?.releaseSha === "string" && SHA.test(root.releaseSha)
      ? root.releaseSha.toLowerCase()
      : null;
  if (!releaseSha) {
    reasons.push("Clinic-pilot release SHA must be an exact commit.");
  }

  const startedAt = timestamp(root?.startedAt);
  const completedAt = timestamp(root?.completedAt);
  if (startedAt == null || completedAt == null) {
    reasons.push("Clinic-pilot timestamps are missing or invalid.");
  } else {
    const duration = completedAt - startedAt;
    if (duration < MIN_PILOT_DURATION_MS || duration > MAX_PILOT_DURATION_MS) {
      reasons.push("Clinic-pilot duration is outside policy.");
    }
    if (completedAt > nowMs + 60_000) {
      reasons.push("Clinic-pilot evidence is dated in the future.");
    } else if (nowMs - completedAt > MAX_EVIDENCE_AGE_MS) {
      reasons.push("Clinic-pilot evidence is older than 30 days.");
    }
    if (
      pilotMatch &&
      pilotMatch[1] !== new Date(completedAt).toISOString().slice(0, 10)
    ) {
      reasons.push("Clinic-pilot evidence ID date does not match completion.");
    }
  }

  const scope = record(root?.pilotScope);
  if (!scope || !exactKeys(scope, PILOT_SCOPE_KEYS)) {
    reasons.push("Clinic-pilot scope is missing or malformed.");
  } else {
    if (!["general_practice", "house_call"].includes(String(scope.workflow))) {
      reasons.push("Clinic-pilot workflow is outside the supported cohort.");
    }
    if (scope.jurisdiction !== "US") {
      reasons.push("Clinic-pilot jurisdiction is outside the first cohort.");
    }
    if (scope.activeLocationCount !== 1) {
      reasons.push("Clinic-pilot scope must contain exactly one location.");
    }
    if (
      !Number.isSafeInteger(scope.distinctClinicDays) ||
      Number(scope.distinctClinicDays) < 5
    ) {
      reasons.push("Clinic-pilot evidence requires five distinct clinic days.");
    }
  }

  const outcomes = record(root?.outcomes);
  if (!outcomes || !exactKeys(outcomes, CLINIC_PILOT_OUTCOMES)) {
    reasons.push("Clinic-pilot outcomes are missing or malformed.");
  } else {
    for (const outcome of CLINIC_PILOT_OUTCOMES) {
      if (outcomes[outcome] !== true) {
        reasons.push(`Clinic-pilot evidence did not prove ${outcome}.`);
      }
    }
  }

  const sourceEvidence = record(root?.sourceEvidence);
  if (!sourceEvidence || !exactKeys(sourceEvidence, SOURCE_EVIDENCE_KEYS)) {
    reasons.push("Clinic-pilot source evidence is missing or malformed.");
  } else {
    if (
      typeof sourceEvidence.clinicUseValidatedHash !== "string" ||
      !SHA256.test(sourceEvidence.clinicUseValidatedHash)
    ) {
      reasons.push("Clinic-pilot validated-use hash is missing or invalid.");
    }
    if (
      !Number.isSafeInteger(sourceEvidence.pilotProjectionVersion) ||
      Number(sourceEvidence.pilotProjectionVersion) <= 0
    ) {
      reasons.push("Clinic-pilot projection version is missing or invalid.");
    }
  }

  const approvals = record(root?.approvals);
  const assignedActors = new Set<string>();
  if (!approvals || !exactKeys(approvals, CLINIC_PILOT_APPROVAL_ROLES)) {
    reasons.push("Clinic-pilot approvals are missing or malformed.");
  } else {
    for (const role of CLINIC_PILOT_APPROVAL_ROLES) {
      const approval = record(approvals[role]);
      if (!approval || !exactKeys(approval, APPROVAL_KEYS)) {
        reasons.push(`Clinic-pilot approval ${role} is malformed.`);
        continue;
      }
      const assigned = actorId(approval.actorId, role);
      if (!assigned || assignedActors.has(assigned)) {
        reasons.push(
          `Clinic-pilot approval ${role} is unassigned or not independent.`,
        );
      } else {
        assignedActors.add(assigned);
      }
      const approvedAt = timestamp(approval.approvedAt);
      if (
        approvedAt == null ||
        completedAt == null ||
        approvedAt < completedAt ||
        approvedAt > completedAt + MAX_APPROVAL_LAG_MS ||
        approvedAt > nowMs + 60_000
      ) {
        reasons.push(`Clinic-pilot approval ${role} has an invalid time.`);
      }
    }
  }

  const safety = record(root?.evidenceSafety);
  if (!safety || !exactKeys(safety, SAFETY_KEYS)) {
    reasons.push("Clinic-pilot evidence safety attestation is malformed.");
  } else {
    for (const field of SAFETY_KEYS) {
      if (safety[field] !== true) {
        reasons.push(`Clinic-pilot evidence is not ${field}.`);
      }
    }
  }

  const findings = record(root?.findings);
  if (!findings || !exactKeys(findings, FINDING_KEYS)) {
    reasons.push("Clinic-pilot finding summary is malformed.");
  } else {
    for (const field of FINDING_KEYS) {
      if (!nonNegativeInteger(findings[field])) {
        reasons.push(`Clinic-pilot ${field} is invalid.`);
      } else if (findings[field] !== 0) {
        reasons.push(`Clinic-pilot ${field} must be zero for release.`);
      }
    }
  }

  return {
    ready: reasons.length === 0,
    pilotId,
    releaseSha,
    evaluatedAt: new Date(nowMs).toISOString(),
    reasons,
  };
}
