import { createHash } from "node:crypto";

const MAX_EVIDENCE_AGE_MS = 15 * 60 * 1_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[0-9a-f]{64}$/i;

const ROOT_KEYS = [
  "checkedAt",
  "clinicAdministratorActorHash",
  "clinicUseValidatedHash",
  "databaseTargetFingerprint",
  "evidenceFormatVersion",
  "evidenceSafety",
  "mode",
  "outcomes",
  "pilotProjectionVersion",
  "projection",
  "releaseSafe",
] as const;
const PROJECTION_KEYS = [
  "blockerCount",
  "decision",
  "immutableEventMatch",
  "matchedPilotCount",
  "qualificationComplete",
  "readinessComplete",
  "stage",
  "workflow",
] as const;
const OUTCOME_KEYS = [
  "activeLocationCount",
  "clinicAcceptanceRecorded",
  "clinicUseValidated",
  "communicationTested",
  "distinctClinicDays",
  "firstVisitValidated",
  "hostedFullAccess",
  "jurisdictionConfirmed",
  "paymentMethodCollected",
  "positivePaymentRecorded",
  "setupComplete",
  "verifiedAdministrator",
] as const;
const SAFETY_KEYS = [
  "contactDestinationsFree",
  "localPathsFree",
  "patientIdentifiersFree",
  "phiFree",
  "secretsFree",
] as const;

type RecordValue = Record<string, unknown>;

export type ClinicPilotProjectionEvidenceDecision = {
  ready: boolean;
  clinicUseValidatedHash: string | null;
  pilotProjectionVersion: number | null;
  databaseTargetFingerprint: string | null;
  clinicAdministratorActorHash: string | null;
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

export function clinicPilotActorHash(actorId: string): string {
  return createHash("sha256").update(actorId.toLowerCase()).digest("hex");
}

/** Strict, PHI-free proof derived from the immutable clinic-pilot projection. */
export function evaluateClinicPilotProjectionEvidence(
  input: unknown,
  nowMs = Date.now(),
): ClinicPilotProjectionEvidenceDecision {
  const reasons: string[] = [];
  const root = record(input);
  if (!root || !exactKeys(root, ROOT_KEYS)) {
    reasons.push(
      "Clinic-pilot projection evidence has an unexpected root shape.",
    );
  }
  if (
    root?.evidenceFormatVersion !== 1 ||
    root?.mode !== "read_only_aggregate"
  ) {
    reasons.push("Clinic-pilot projection evidence format is invalid.");
  }

  const checkedAt = timestamp(root?.checkedAt);
  if (checkedAt == null) {
    reasons.push("Clinic-pilot projection timestamp is missing or invalid.");
  } else if (checkedAt > nowMs + 60_000) {
    reasons.push("Clinic-pilot projection evidence is dated in the future.");
  } else if (nowMs - checkedAt > MAX_EVIDENCE_AGE_MS) {
    reasons.push("Clinic-pilot projection evidence is stale.");
  }

  const clinicUseValidatedHash =
    typeof root?.clinicUseValidatedHash === "string" &&
    SHA256.test(root.clinicUseValidatedHash)
      ? root.clinicUseValidatedHash.toLowerCase()
      : null;
  if (!clinicUseValidatedHash) {
    reasons.push("Clinic-pilot projection validated-use hash is invalid.");
  }
  const pilotProjectionVersion =
    Number.isSafeInteger(root?.pilotProjectionVersion) &&
    Number(root?.pilotProjectionVersion) > 0
      ? Number(root?.pilotProjectionVersion)
      : null;
  if (!pilotProjectionVersion) {
    reasons.push("Clinic-pilot projection version is invalid.");
  }
  const databaseTargetFingerprint =
    typeof root?.databaseTargetFingerprint === "string" &&
    SHA256.test(root.databaseTargetFingerprint)
      ? root.databaseTargetFingerprint.toLowerCase()
      : null;
  if (!databaseTargetFingerprint) {
    reasons.push("Clinic-pilot projection database fingerprint is invalid.");
  }
  const clinicAdministratorActorHash =
    typeof root?.clinicAdministratorActorHash === "string" &&
    SHA256.test(root.clinicAdministratorActorHash)
      ? root.clinicAdministratorActorHash.toLowerCase()
      : null;
  if (!clinicAdministratorActorHash) {
    reasons.push("Clinic-pilot projection administrator binding is invalid.");
  }

  const projection = record(root?.projection);
  if (!projection || !exactKeys(projection, PROJECTION_KEYS)) {
    reasons.push("Clinic-pilot projection summary is malformed.");
  } else {
    if (projection.matchedPilotCount !== 1) {
      reasons.push("Clinic-pilot projection must match exactly one pilot.");
    }
    if (projection.immutableEventMatch !== true) {
      reasons.push("Clinic-pilot projection lacks an exact immutable event.");
    }
    if (
      !["general_practice", "house_call"].includes(String(projection.workflow))
    ) {
      reasons.push("Clinic-pilot projection workflow is unsupported.");
    }
    if (
      projection.stage !== "completed" ||
      projection.decision !== "graduated"
    ) {
      reasons.push("Clinic-pilot projection is not graduated.");
    }
    if (projection.blockerCount !== 0) {
      reasons.push("Clinic-pilot projection still has blockers.");
    }
    if (
      projection.qualificationComplete !== true ||
      projection.readinessComplete !== true
    ) {
      reasons.push("Clinic-pilot projection checklists are incomplete.");
    }
  }

  const outcomes = record(root?.outcomes);
  if (!outcomes || !exactKeys(outcomes, OUTCOME_KEYS)) {
    reasons.push("Clinic-pilot projection outcomes are malformed.");
  } else {
    for (const outcome of OUTCOME_KEYS.filter(
      (field) => !["activeLocationCount", "distinctClinicDays"].includes(field),
    )) {
      if (outcomes[outcome] !== true) {
        reasons.push(`Clinic-pilot projection did not prove ${outcome}.`);
      }
    }
    if (outcomes.activeLocationCount !== 1) {
      reasons.push(
        "Clinic-pilot projection must contain exactly one location.",
      );
    }
    if (
      !Number.isSafeInteger(outcomes.distinctClinicDays) ||
      Number(outcomes.distinctClinicDays) < 5
    ) {
      reasons.push("Clinic-pilot projection requires five clinic days.");
    }
  }

  const safety = record(root?.evidenceSafety);
  if (!safety || !exactKeys(safety, SAFETY_KEYS)) {
    reasons.push("Clinic-pilot projection safety attestation is malformed.");
  } else {
    for (const field of SAFETY_KEYS) {
      if (safety[field] !== true) {
        reasons.push(`Clinic-pilot projection evidence is not ${field}.`);
      }
    }
  }
  if (root?.releaseSafe !== true) {
    reasons.push("Clinic-pilot projection is not release-safe.");
  }

  return {
    ready: reasons.length === 0,
    clinicUseValidatedHash,
    pilotProjectionVersion,
    databaseTargetFingerprint,
    clinicAdministratorActorHash,
    evaluatedAt: new Date(nowMs).toISOString(),
    reasons,
  };
}
