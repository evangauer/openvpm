import { describe, expect, it } from "vitest";
import {
  CLINIC_PILOT_OUTCOMES,
  evaluateClinicPilotReleaseEvidence,
} from "../clinic-pilot-release-evidence";

const now = Date.parse("2026-08-30T21:00:00.000Z");
const releaseSha = "a".repeat(40);

export function healthyClinicPilotReleaseEvidence() {
  return {
    evidenceFormatVersion: 1,
    pilotId: "pilot-2026-08-30-deadbeef",
    releaseSha,
    startedAt: "2026-08-25T14:00:00.000Z",
    completedAt: "2026-08-30T19:00:00.000Z",
    pilotScope: {
      workflow: "general_practice",
      jurisdiction: "US",
      activeLocationCount: 1,
      distinctClinicDays: 5,
    },
    outcomes: Object.fromEntries(
      CLINIC_PILOT_OUTCOMES.map((outcome) => [outcome, true]),
    ) as Record<(typeof CLINIC_PILOT_OUTCOMES)[number], boolean>,
    sourceEvidence: {
      clinicUseValidatedHash: "b".repeat(64),
      pilotProjectionVersion: 7,
    },
    approvals: {
      clinicAdministrator: {
        actorId: "user:5f55c40b-0e87-4af2-94a8-fbe97ff5ca15",
        approvedAt: "2026-08-30T19:10:00.000Z",
      },
      veterinaryClinicalOwner: {
        actorId: "github:@clinical-owner",
        approvedAt: "2026-08-30T19:20:00.000Z",
      },
      releaseOwner: {
        actorId: "github:@release-owner",
        approvedAt: "2026-08-30T19:30:00.000Z",
      },
      securityOwner: {
        actorId: "github:@security-owner",
        approvedAt: "2026-08-30T19:40:00.000Z",
      },
    },
    evidenceSafety: {
      phiFree: true,
      secretsFree: true,
      patientIdentifiersFree: true,
      contactDestinationsFree: true,
      localPathsFree: true,
    },
    findings: {
      criticalCount: 0,
      highCount: 0,
      openReleaseBlockingCount: 0,
    },
  };
}

describe("clinic-pilot release evidence", () => {
  it("accepts a fresh five-day pilot for one exact release", () => {
    expect(
      evaluateClinicPilotReleaseEvidence(
        healthyClinicPilotReleaseEvidence(),
        now,
      ),
    ).toEqual({
      ready: true,
      pilotId: "pilot-2026-08-30-deadbeef",
      releaseSha,
      evaluatedAt: "2026-08-30T21:00:00.000Z",
      reasons: [],
    });
  });

  it("rejects automation-only proof without five clinic days or acceptance", () => {
    const evidence = healthyClinicPilotReleaseEvidence();
    evidence.pilotScope.distinctClinicDays = 1;
    evidence.outcomes.clinicUseValidated = false;
    evidence.outcomes.clinicAcceptanceRecorded = false;
    const reasons = evaluateClinicPilotReleaseEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Clinic-pilot evidence requires five distinct clinic days.",
        "Clinic-pilot evidence did not prove clinicUseValidated.",
        "Clinic-pilot evidence did not prove clinicAcceptanceRecorded.",
      ]),
    );
  });

  it("requires four independent role-appropriate approvals", () => {
    const evidence = healthyClinicPilotReleaseEvidence();
    evidence.approvals.clinicAdministrator.actorId = "github:@clinical-owner";
    evidence.approvals.securityOwner.actorId = "github:@release-owner";
    const reasons = evaluateClinicPilotReleaseEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Clinic-pilot approval clinicAdministrator is unassigned or not independent.",
        "Clinic-pilot approval securityOwner is unassigned or not independent.",
      ]),
    );
  });

  it("rejects stale, future, or pre-completion approvals", () => {
    const evidence = healthyClinicPilotReleaseEvidence();
    evidence.completedAt = "2026-06-30T19:00:00.000Z";
    evidence.pilotId = "pilot-2026-06-30-deadbeef";
    evidence.startedAt = "2026-06-25T14:00:00.000Z";
    evidence.approvals.releaseOwner.approvedAt = "2026-06-30T18:59:00.000Z";
    const reasons = evaluateClinicPilotReleaseEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Clinic-pilot evidence is older than 30 days.",
        "Clinic-pilot approval releaseOwner has an invalid time.",
      ]),
    );
  });

  it("requires zero critical, high, and release-blocking findings", () => {
    const evidence = healthyClinicPilotReleaseEvidence();
    evidence.findings.highCount = 1;
    evidence.findings.openReleaseBlockingCount = 2;
    const reasons = evaluateClinicPilotReleaseEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Clinic-pilot highCount must be zero for release.",
        "Clinic-pilot openReleaseBlockingCount must be zero for release.",
      ]),
    );
  });

  it("requires immutable validated-use source linkage", () => {
    const evidence = healthyClinicPilotReleaseEvidence();
    evidence.sourceEvidence.clinicUseValidatedHash = "not-a-hash";
    evidence.sourceEvidence.pilotProjectionVersion = 0;
    const reasons = evaluateClinicPilotReleaseEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Clinic-pilot validated-use hash is missing or invalid.",
        "Clinic-pilot projection version is missing or invalid.",
      ]),
    );
  });

  it("rejects free-form or unsafe evidence fields", () => {
    const evidence = healthyClinicPilotReleaseEvidence() as ReturnType<
      typeof healthyClinicPilotReleaseEvidence
    > & { notes?: string };
    evidence.notes = "patient details must never be copied here";
    evidence.evidenceSafety.patientIdentifiersFree = false;
    const reasons = evaluateClinicPilotReleaseEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Clinic-pilot evidence has an unexpected root shape.",
        "Clinic-pilot evidence is not patientIdentifiersFree.",
      ]),
    );
  });
});
