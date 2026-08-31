const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_DRILL_DURATION_MS = 5 * 60 * 1_000;
const MAX_DRILL_DURATION_MS = 8 * 60 * 60 * 1_000;
const MAX_BACKUP_AGE_MS = 36 * 60 * 60 * 1_000;
const MAX_APPROVAL_LEAD_MS = 7 * 24 * 60 * 60 * 1_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DRILL_ID = /^restore-(\d{4}-\d{2}-\d{2})-[a-f0-9]{8}$/;
const SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const GITHUB_HANDLE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,36}[A-Za-z0-9])?$/;
// Provider version identifiers are opaque. S3-compatible stores commonly use
// base64-like IDs containing `+`, `/`, or `=`, while other providers use UUIDs.
// Keep the field single-line and bounded without rewriting the provider value.
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._~+/=:-]{0,255}$/;

const ROOT_KEYS = [
  "completedAt",
  "databaseBackup",
  "drillId",
  "evidenceFormatVersion",
  "evidenceSafety",
  "findings",
  "independentObject",
  "metrics",
  "operators",
  "recoveryHold",
  "releaseSha",
  "smoke",
  "startedAt",
  "status",
  "synthetic",
] as const;
const DATABASE_BACKUP_KEYS = [
  "backupVersionId",
  "checksumSha256",
  "exactVersionVerified",
  "exportedAt",
  "restoreTargetFingerprint",
] as const;
const OBJECT_KEYS = [
  "checksumSha256",
  "exactVersionVerified",
  "fileSizeBytes",
  "objectVersionId",
] as const;
const OPERATOR_KEYS = ["approvedAt", "approver", "requester"] as const;
const HOLD_KEYS = [
  "observedBeforeReconciliation",
  "releasedAfterChecklistAndDatabaseGate",
] as const;
const SMOKE_KEYS = [
  "authenticationResetRequired",
  "clinicalRows",
  "fileAccessRows",
  "invoiceRows",
  "paymentRows",
  "schedulingRows",
  "tenantIsolation",
] as const;
const METRIC_KEYS = ["rpoMs", "rtoMs"] as const;
const SAFETY_KEYS = [
  "contactDestinationsFree",
  "localPathsFree",
  "patientIdentifiersFree",
  "phiFree",
  "providerPayloadsFree",
  "secretsFree",
] as const;
const FINDING_KEYS = [
  "criticalCount",
  "highCount",
  "openReleaseBlockingCount",
] as const;

type RecordValue = Record<string, unknown>;

export type ProviderRestoreReleaseEvidenceDecision = {
  ready: boolean;
  drillId: string | null;
  releaseSha: string | null;
  restoreTargetFingerprint: string | null;
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
    GITHUB_HANDLE.test(value) &&
    !/^@(unassigned|unknown|replace|todo|tbd)(?:-|$)/i.test(value)
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Strict, identifier-free evidence for a real provider-backed restore drill. */
export function evaluateProviderRestoreReleaseEvidence(
  input: unknown,
  nowMs = Date.now(),
): ProviderRestoreReleaseEvidenceDecision {
  const reasons: string[] = [];
  const root = record(input);
  if (!root || !exactKeys(root, ROOT_KEYS)) {
    reasons.push("Provider-restore evidence has an unexpected root shape.");
  }
  if (root?.evidenceFormatVersion !== 1) {
    reasons.push("Provider-restore evidence format version must be 1.");
  }
  if (root?.status !== "passed" || root?.synthetic !== false) {
    reasons.push("A passed, non-synthetic provider restore is required.");
  }

  const drillMatch =
    typeof root?.drillId === "string" ? DRILL_ID.exec(root.drillId) : null;
  const drillId = drillMatch ? (root?.drillId as string) : null;
  if (!drillId) reasons.push("Provider-restore drill ID is invalid.");
  const releaseSha =
    typeof root?.releaseSha === "string" && SHA.test(root.releaseSha)
      ? root.releaseSha.toLowerCase()
      : null;
  if (!releaseSha) {
    reasons.push("Provider-restore release SHA must be an exact commit.");
  }

  const startedAt = timestamp(root?.startedAt);
  const completedAt = timestamp(root?.completedAt);
  if (startedAt == null || completedAt == null) {
    reasons.push("Provider-restore timestamps are missing or invalid.");
  } else {
    const duration = completedAt - startedAt;
    if (duration < MIN_DRILL_DURATION_MS || duration > MAX_DRILL_DURATION_MS) {
      reasons.push("Provider-restore duration is outside policy.");
    }
    if (completedAt > nowMs + 60_000) {
      reasons.push("Provider-restore evidence is dated in the future.");
    } else if (nowMs - completedAt > MAX_EVIDENCE_AGE_MS) {
      reasons.push("Provider-restore evidence is older than 30 days.");
    }
    if (
      drillMatch &&
      drillMatch[1] !== new Date(completedAt).toISOString().slice(0, 10)
    ) {
      reasons.push("Provider-restore drill ID date does not match completion.");
    }
  }

  const operators = record(root?.operators);
  if (!operators || !exactKeys(operators, OPERATOR_KEYS)) {
    reasons.push("Provider-restore operators are missing or malformed.");
  } else {
    const requester = safeHandle(operators.requester)
      ? operators.requester.toLowerCase()
      : null;
    const approver = safeHandle(operators.approver)
      ? operators.approver.toLowerCase()
      : null;
    if (!requester || !approver || requester === approver) {
      reasons.push("Provider restore requires distinct named operators.");
    }
    const approvedAt = timestamp(operators.approvedAt);
    if (
      approvedAt == null ||
      startedAt == null ||
      approvedAt > startedAt ||
      startedAt - approvedAt > MAX_APPROVAL_LEAD_MS ||
      approvedAt > nowMs + 60_000
    ) {
      reasons.push("Provider-restore approval time is invalid.");
    }
  }

  const databaseBackup = record(root?.databaseBackup);
  let backupExportedAt: number | null = null;
  let restoreTargetFingerprint: string | null = null;
  if (!databaseBackup || !exactKeys(databaseBackup, DATABASE_BACKUP_KEYS)) {
    reasons.push("Provider database-backup evidence is missing or malformed.");
  } else {
    backupExportedAt = timestamp(databaseBackup.exportedAt);
    restoreTargetFingerprint =
      typeof databaseBackup.restoreTargetFingerprint === "string" &&
      SHA256.test(databaseBackup.restoreTargetFingerprint)
        ? databaseBackup.restoreTargetFingerprint.toLowerCase()
        : null;
    if (
      typeof databaseBackup.backupVersionId !== "string" ||
      !VERSION_ID.test(databaseBackup.backupVersionId) ||
      typeof databaseBackup.checksumSha256 !== "string" ||
      !SHA256.test(databaseBackup.checksumSha256) ||
      !restoreTargetFingerprint ||
      databaseBackup.exactVersionVerified !== true
    ) {
      reasons.push("Provider database-backup identity is incomplete.");
    }
    if (
      backupExportedAt == null ||
      startedAt == null ||
      backupExportedAt > startedAt ||
      startedAt - backupExportedAt > MAX_BACKUP_AGE_MS
    ) {
      reasons.push("Provider database backup is stale or future-dated.");
    }
  }

  const object = record(root?.independentObject);
  if (!object || !exactKeys(object, OBJECT_KEYS)) {
    reasons.push(
      "Independent object restore evidence is missing or malformed.",
    );
  } else if (
    typeof object.objectVersionId !== "string" ||
    !VERSION_ID.test(object.objectVersionId) ||
    typeof object.checksumSha256 !== "string" ||
    !SHA256.test(object.checksumSha256) ||
    !nonNegativeInteger(object.fileSizeBytes) ||
    object.exactVersionVerified !== true
  ) {
    reasons.push("Independent object restore identity is incomplete.");
  }

  const hold = record(root?.recoveryHold);
  if (!hold || !exactKeys(hold, HOLD_KEYS)) {
    reasons.push("Provider-restore recovery-hold evidence is malformed.");
  } else if (
    hold.observedBeforeReconciliation !== true ||
    hold.releasedAfterChecklistAndDatabaseGate !== true
  ) {
    reasons.push("Provider-restore recovery hold was not safely released.");
  }

  const smoke = record(root?.smoke);
  if (!smoke || !exactKeys(smoke, SMOKE_KEYS)) {
    reasons.push("Provider-restore smoke evidence is missing or malformed.");
  } else {
    if (smoke.authenticationResetRequired !== true) {
      reasons.push("Provider restore did not require authentication reset.");
    }
    if (smoke.tenantIsolation !== true) {
      reasons.push("Provider restore did not prove tenant isolation.");
    }
    for (const field of SMOKE_KEYS.filter(
      (item) =>
        !["authenticationResetRequired", "tenantIsolation"].includes(item),
    )) {
      if (!Number.isSafeInteger(smoke[field]) || Number(smoke[field]) <= 0) {
        reasons.push(`Provider-restore smoke ${field} is missing.`);
      }
    }
  }

  const metrics = record(root?.metrics);
  if (!metrics || !exactKeys(metrics, METRIC_KEYS)) {
    reasons.push("Provider-restore RPO/RTO evidence is malformed.");
  } else {
    const expectedRpo =
      startedAt != null && backupExportedAt != null
        ? startedAt - backupExportedAt
        : null;
    const duration =
      startedAt != null && completedAt != null ? completedAt - startedAt : null;
    if (
      !nonNegativeInteger(metrics.rpoMs) ||
      expectedRpo == null ||
      metrics.rpoMs !== expectedRpo ||
      metrics.rpoMs > MAX_BACKUP_AGE_MS
    ) {
      reasons.push("Provider-restore RPO evidence is invalid.");
    }
    if (
      !nonNegativeInteger(metrics.rtoMs) ||
      duration == null ||
      metrics.rtoMs > duration ||
      metrics.rtoMs > MAX_DRILL_DURATION_MS
    ) {
      reasons.push("Provider-restore RTO evidence is invalid.");
    }
  }

  const safety = record(root?.evidenceSafety);
  if (!safety || !exactKeys(safety, SAFETY_KEYS)) {
    reasons.push("Provider-restore safety attestation is malformed.");
  } else {
    for (const field of SAFETY_KEYS) {
      if (safety[field] !== true) {
        reasons.push(`Provider-restore evidence is not ${field}.`);
      }
    }
  }

  const findings = record(root?.findings);
  if (!findings || !exactKeys(findings, FINDING_KEYS)) {
    reasons.push("Provider-restore finding summary is malformed.");
  } else {
    for (const field of FINDING_KEYS) {
      if (!nonNegativeInteger(findings[field])) {
        reasons.push(`Provider-restore ${field} is invalid.`);
      } else if (findings[field] !== 0) {
        reasons.push(`Provider-restore ${field} must be zero for release.`);
      }
    }
  }

  return {
    ready: reasons.length === 0,
    drillId,
    releaseSha,
    restoreTargetFingerprint,
    evaluatedAt: new Date(nowMs).toISOString(),
    reasons,
  };
}
