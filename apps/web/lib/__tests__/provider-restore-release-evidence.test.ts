import { describe, expect, it } from "vitest";
import { evaluateProviderRestoreReleaseEvidence } from "../provider-restore-release-evidence";

const now = Date.parse("2026-08-30T21:00:00.000Z");
const releaseSha = "a".repeat(40);

export function healthyProviderRestoreEvidence() {
  return {
    evidenceFormatVersion: 1,
    drillId: "restore-2026-08-30-deadbeef",
    releaseSha,
    startedAt: "2026-08-30T18:00:00.000Z",
    completedAt: "2026-08-30T19:00:00.000Z",
    status: "passed",
    synthetic: false,
    operators: {
      requester: "@restore-operator",
      approver: "@restore-approver",
      approvedAt: "2026-08-30T17:30:00.000Z",
    },
    databaseBackup: {
      backupVersionId: "backup-provider-version-42",
      checksumSha256: "b".repeat(64),
      exportedAt: "2026-08-30T17:00:00.000Z",
      restoreTargetFingerprint: "e".repeat(64),
      exactVersionVerified: true,
    },
    independentObject: {
      objectVersionId: "object-provider-version-17",
      checksumSha256: "d".repeat(64),
      fileSizeBytes: 45,
      exactVersionVerified: true,
    },
    recoveryHold: {
      observedBeforeReconciliation: true,
      releasedAfterChecklistAndDatabaseGate: true,
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
    metrics: { rpoMs: 3_600_000, rtoMs: 3_000_000 },
    evidenceSafety: {
      phiFree: true,
      secretsFree: true,
      providerPayloadsFree: true,
      localPathsFree: true,
      patientIdentifiersFree: true,
      contactDestinationsFree: true,
    },
    findings: {
      criticalCount: 0,
      highCount: 0,
      openReleaseBlockingCount: 0,
    },
  };
}

describe("provider-restore release evidence", () => {
  it("accepts fresh exact-version database and object recovery evidence", () => {
    expect(
      evaluateProviderRestoreReleaseEvidence(
        healthyProviderRestoreEvidence(),
        now,
      ),
    ).toEqual({
      ready: true,
      drillId: "restore-2026-08-30-deadbeef",
      releaseSha,
      restoreTargetFingerprint: "e".repeat(64),
      evaluatedAt: "2026-08-30T21:00:00.000Z",
      reasons: [],
    });
  });

  it("accepts bounded opaque provider version identifiers", () => {
    const evidence = healthyProviderRestoreEvidence();
    evidence.databaseBackup.backupVersionId = "3Lg+provider/version==";
    evidence.independentObject.objectVersionId = "01J_uuid~provider:value";

    expect(evaluateProviderRestoreReleaseEvidence(evidence, now)).toMatchObject(
      { ready: true, reasons: [] },
    );
  });

  it("rejects control characters and command-like version identifiers", () => {
    const evidence = healthyProviderRestoreEvidence();
    evidence.databaseBackup.backupVersionId = "provider-version\nsecond-line";
    evidence.independentObject.objectVersionId = "provider-version;rm";

    const reasons = evaluateProviderRestoreReleaseEvidence(
      evidence,
      now,
    ).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Provider database-backup identity is incomplete.",
        "Independent object restore identity is incomplete.",
      ]),
    );
  });

  it("rejects synthetic, stale, or cross-release evidence", () => {
    const evidence = healthyProviderRestoreEvidence();
    evidence.synthetic = true;
    evidence.releaseSha = "not-a-sha";
    evidence.completedAt = "2026-06-30T19:00:00.000Z";
    evidence.startedAt = "2026-06-30T18:00:00.000Z";
    evidence.drillId = "restore-2026-06-30-deadbeef";
    const reasons = evaluateProviderRestoreReleaseEvidence(
      evidence,
      now,
    ).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "A passed, non-synthetic provider restore is required.",
        "Provider-restore release SHA must be an exact commit.",
        "Provider-restore evidence is older than 30 days.",
      ]),
    );
  });

  it("requires dual control before execution", () => {
    const evidence = healthyProviderRestoreEvidence();
    evidence.operators.approver = "@restore-operator";
    evidence.operators.approvedAt = "2026-08-30T18:30:00.000Z";
    const reasons = evaluateProviderRestoreReleaseEvidence(
      evidence,
      now,
    ).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Provider restore requires distinct named operators.",
        "Provider-restore approval time is invalid.",
      ]),
    );
  });

  it("requires exact database and object versions plus matching RPO/RTO", () => {
    const evidence = healthyProviderRestoreEvidence();
    evidence.databaseBackup.exactVersionVerified = false;
    evidence.independentObject.checksumSha256 = "bad";
    evidence.metrics.rpoMs = 1;
    evidence.metrics.rtoMs = 4_000_000;
    const reasons = evaluateProviderRestoreReleaseEvidence(
      evidence,
      now,
    ).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Provider database-backup identity is incomplete.",
        "Independent object restore identity is incomplete.",
        "Provider-restore RPO evidence is invalid.",
        "Provider-restore RTO evidence is invalid.",
      ]),
    );
  });

  it("rejects empty-object and zero-duration recovery claims", () => {
    const evidence = healthyProviderRestoreEvidence();
    evidence.independentObject.fileSizeBytes = 0;
    evidence.metrics.rtoMs = 0;

    const reasons = evaluateProviderRestoreReleaseEvidence(
      evidence,
      now,
    ).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Independent object restore identity is incomplete.",
        "Provider-restore RTO evidence is invalid.",
      ]),
    );
  });

  it("rejects missing recovery smokes and release-blocking findings", () => {
    const evidence = healthyProviderRestoreEvidence();
    evidence.recoveryHold.releasedAfterChecklistAndDatabaseGate = false;
    evidence.smoke.fileAccessRows = 0;
    evidence.findings.openReleaseBlockingCount = 1;
    const reasons = evaluateProviderRestoreReleaseEvidence(
      evidence,
      now,
    ).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Provider-restore recovery hold was not safely released.",
        "Provider-restore smoke fileAccessRows is missing.",
        "Provider-restore openReleaseBlockingCount must be zero for release.",
      ]),
    );
  });

  it("rejects extra or unsafe fields that could carry sensitive data", () => {
    const evidence = healthyProviderRestoreEvidence() as ReturnType<
      typeof healthyProviderRestoreEvidence
    > & { patientName?: string };
    evidence.patientName = "must not be copied";
    evidence.evidenceSafety.phiFree = false;
    const reasons = evaluateProviderRestoreReleaseEvidence(
      evidence,
      now,
    ).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Provider-restore evidence has an unexpected root shape.",
        "Provider-restore evidence is not phiFree.",
      ]),
    );
  });
});
