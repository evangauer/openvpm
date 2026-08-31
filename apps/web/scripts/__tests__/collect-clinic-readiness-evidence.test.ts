import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collect: vi.fn(async () => ({ evidenceFormatVersion: 11 })),
  evaluate: vi.fn(() => ({
    decision: "GO",
    evaluatedAt: "2026-08-29T21:00:00.000Z",
    releaseSha: "a".repeat(40),
    reasons: [],
  })),
}));

vi.mock("../../lib/clinic-readiness-evidence-collector", () => ({
  collectClinicReadinessEvidence: mocks.collect,
}));
vi.mock("../../lib/clinic-readiness-release", () => ({
  evaluateClinicReadinessRelease: mocks.evaluate,
}));

import { main } from "../collect-clinic-readiness-evidence";

const temporaryDirectories: string[] = [];
const originalInitCwd = process.env.INIT_CWD;

afterEach(() => {
  vi.restoreAllMocks();
  mocks.collect.mockClear();
  mocks.evaluate.mockClear();
  if (originalInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = originalInitCwd;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function argumentsFor(output: string): string[] {
  return [
    "--",
    "--release-sha",
    "a".repeat(40),
    "--repository",
    "openvpm/openvpm",
    "--ci-run-id",
    "101",
    "--staging-migration-run-id",
    "151",
    "--staging-reset-run-id",
    "171",
    "--staging-database-fingerprint",
    "e".repeat(64),
    "--migration-run-id",
    "202",
    "--staging-health-url",
    "https://staging.example/api/health",
    "--hosted-health-url",
    "https://production.example/api/health",
    "--restore-evidence",
    "private/restore.json",
    "--incident-evidence",
    "private/incident.json",
    "--auth-recovery-evidence",
    "private/auth-recovery.json",
    "--clinic-pilot-evidence",
    "private/clinic-pilot.json",
    "--clinic-pilot-projection-audit",
    "private/clinic-pilot-projection.json",
    "--clinical-database-fingerprint",
    "d".repeat(64),
    "--controlled-substance-audit",
    "private/controlled-substances.json",
    "--prescription-audit",
    "private/prescriptions.json",
    "--lab-result-audit",
    "private/lab-results.json",
    "--vaccination-audit",
    "private/vaccinations.json",
    "--output",
    output,
  ];
}

describe("clinic readiness evidence collector CLI", () => {
  it("accepts pnpm's separator, resolves operator paths, and redacts output paths", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "openvpm-private-clinic-evidence-"),
    );
    temporaryDirectories.push(directory);
    process.env.INIT_CWD = directory;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(argumentsFor("release.json"));

    expect(existsSync(path.join(directory, "release.json"))).toBe(true);
    expect(mocks.collect).toHaveBeenCalledWith(
      expect.objectContaining({
        restoreEvidencePath: path.join(directory, "private/restore.json"),
        incidentEvidencePath: path.join(directory, "private/incident.json"),
        authRecoveryEvidencePath: path.join(
          directory,
          "private/auth-recovery.json",
        ),
        clinicPilotEvidencePath: path.join(
          directory,
          "private/clinic-pilot.json",
        ),
        clinicPilotProjectionAuditPath: path.join(
          directory,
          "private/clinic-pilot-projection.json",
        ),
        clinicalDatabaseFingerprint: "d".repeat(64),
        controlledSubstanceAuditPath: path.join(
          directory,
          "private/controlled-substances.json",
        ),
        prescriptionAuditPath: path.join(
          directory,
          "private/prescriptions.json",
        ),
        labResultAuditPath: path.join(directory, "private/lab-results.json"),
        vaccinationAuditPath: path.join(directory, "private/vaccinations.json"),
      }),
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain(directory);
    expect(log.mock.calls.flat().join(" ")).toContain("evidenceWritten");

    const error = await main(argumentsFor("release.json")).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Clinic-readiness evidence output could not be created.",
    );
    expect((error as Error).message).not.toContain(directory);
  });
});
