import { describe, expect, it } from "vitest";
import { evaluateClinicReadinessRelease } from "../clinic-readiness-release";

const now = Date.parse("2026-08-29T21:00:00.000Z");
const sha = "a".repeat(40);

function healthyEvidence() {
  const checks: Record<string, { ok: boolean; advisory?: boolean }> =
    Object.fromEntries(
      [
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
  return {
    evidenceFormatVersion: 1,
    releaseSha: sha,
    ci: {
      releaseSha: sha,
      gates: {
        migrations: "passed",
        rls: "passed",
        tests: "passed",
        build: "passed",
        dependencyAudit: "passed",
      },
    },
    hostedHealth: {
      releaseSha: sha,
      checkedAt: "2026-08-29T20:55:00.000Z",
      statusCode: 200,
      body: { ok: true, mode: "hosted", checks },
    },
    restoreDrill: {
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
    },
  };
}

describe("clinic readiness release decision", () => {
  it("returns GO only for complete, fresh, exact-SHA evidence", () => {
    expect(evaluateClinicReadinessRelease(healthyEvidence(), now)).toMatchObject({
      decision: "GO",
      releaseSha: sha,
      reasons: [],
    });
  });

  it("fails closed when any required CI gate is absent", () => {
    const evidence = healthyEvidence();
    delete (evidence.ci.gates as Partial<typeof evidence.ci.gates>).rls;
    expect(evaluateClinicReadinessRelease(evidence, now)).toMatchObject({
      decision: "NO_GO",
      reasons: ["CI gate rls has not passed."],
    });
  });

  it("requires backup and replica health to be affirmative release gates", () => {
    const evidence = healthyEvidence();
    evidence.hostedHealth.body.checks.hostedBackupFreshness.ok = false;
    evidence.hostedHealth.body.checks.hostedFileReplica.advisory = true;
    const decision = evaluateClinicReadinessRelease(evidence, now);
    expect(decision.decision).toBe("NO_GO");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "Hosted check hostedBackupFreshness is missing or unhealthy.",
        "Hosted check hostedFileReplica is still advisory.",
      ]),
    );
  });

  it("rejects any required hosted control that was not actually asserted", () => {
    const evidence = healthyEvidence();
    evidence.hostedHealth.body.checks.hostedRlsRole.advisory = true;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Hosted check hostedRlsRole is still advisory.",
    );
  });

  it("rejects an unknown evidence format", () => {
    const evidence = healthyEvidence();
    evidence.evidenceFormatVersion = 2;
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Clinic readiness evidence format version must be 1.",
    );
  });

  it("rejects stale health and a synthetic-only restore drill", () => {
    const evidence = healthyEvidence();
    evidence.hostedHealth.checkedAt = "2026-08-29T20:00:00.000Z";
    evidence.restoreDrill.synthetic = true;
    const decision = evaluateClinicReadinessRelease(evidence, now);
    expect(decision.decision).toBe("NO_GO");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        "Hosted health evidence is stale.",
        "A provider-backed non-synthetic restore drill is required.",
      ]),
    );
  });

  it("rejects evidence from another release SHA", () => {
    const evidence = healthyEvidence();
    evidence.restoreDrill.releaseSha = "c".repeat(40);
    expect(evaluateClinicReadinessRelease(evidence, now).reasons).toContain(
      "Restore drill does not match the release SHA.",
    );
  });
});
