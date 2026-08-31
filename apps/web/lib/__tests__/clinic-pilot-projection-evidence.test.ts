import { describe, expect, it } from "vitest";
import {
  clinicPilotActorHash,
  evaluateClinicPilotProjectionEvidence,
} from "../clinic-pilot-projection-evidence";

const now = Date.parse("2026-08-30T21:00:00.000Z");

export function healthyClinicPilotProjectionEvidence() {
  return {
    evidenceFormatVersion: 1,
    mode: "read_only_aggregate",
    checkedAt: "2026-08-30T20:55:00.000Z",
    databaseTargetFingerprint: "d".repeat(64),
    clinicUseValidatedHash: "b".repeat(64),
    pilotProjectionVersion: 7,
    clinicAdministratorActorHash: clinicPilotActorHash(
      "user:5f55c40b-0e87-4af2-94a8-fbe97ff5ca15",
    ),
    projection: {
      matchedPilotCount: 1,
      immutableEventMatch: true,
      workflow: "general_practice",
      stage: "completed",
      decision: "graduated",
      blockerCount: 0,
      qualificationComplete: true,
      readinessComplete: true,
    },
    outcomes: {
      verifiedAdministrator: true,
      activeLocationCount: 1,
      setupComplete: true,
      communicationTested: true,
      firstVisitValidated: true,
      distinctClinicDays: 5,
      clinicUseValidated: true,
      paymentMethodCollected: true,
      positivePaymentRecorded: true,
      hostedFullAccess: true,
      jurisdictionConfirmed: true,
      clinicAcceptanceRecorded: true,
    },
    evidenceSafety: {
      phiFree: true,
      secretsFree: true,
      patientIdentifiersFree: true,
      contactDestinationsFree: true,
      localPathsFree: true,
    },
    releaseSafe: true,
  };
}

describe("clinic-pilot projection evidence", () => {
  it("accepts a fresh exact immutable projection", () => {
    expect(
      evaluateClinicPilotProjectionEvidence(
        healthyClinicPilotProjectionEvidence(),
        now,
      ),
    ).toMatchObject({
      ready: true,
      clinicUseValidatedHash: "b".repeat(64),
      pilotProjectionVersion: 7,
      databaseTargetFingerprint: "d".repeat(64),
      reasons: [],
    });
  });

  it("rejects a missing immutable event, blockers, and incomplete outcomes", () => {
    const evidence = healthyClinicPilotProjectionEvidence();
    evidence.projection.immutableEventMatch = false;
    evidence.projection.blockerCount = 1;
    evidence.outcomes.firstVisitValidated = false;

    expect(
      evaluateClinicPilotProjectionEvidence(evidence, now).reasons,
    ).toEqual(
      expect.arrayContaining([
        "Clinic-pilot projection lacks an exact immutable event.",
        "Clinic-pilot projection still has blockers.",
        "Clinic-pilot projection did not prove firstVisitValidated.",
      ]),
    );
  });

  it("rejects stale, cross-shape, unsafe evidence", () => {
    const evidence = healthyClinicPilotProjectionEvidence() as ReturnType<
      typeof healthyClinicPilotProjectionEvidence
    > & { clinicName?: string };
    evidence.checkedAt = "2026-08-30T20:00:00.000Z";
    evidence.clinicName = "must not be copied";
    evidence.evidenceSafety.phiFree = false;

    expect(
      evaluateClinicPilotProjectionEvidence(evidence, now).reasons,
    ).toEqual(
      expect.arrayContaining([
        "Clinic-pilot projection evidence has an unexpected root shape.",
        "Clinic-pilot projection evidence is stale.",
        "Clinic-pilot projection evidence is not phiFree.",
      ]),
    );
  });

  it("normalizes administrator actor IDs before hashing", () => {
    expect(clinicPilotActorHash("USER:ABC")).toBe(
      clinicPilotActorHash("user:abc"),
    );
  });
});
