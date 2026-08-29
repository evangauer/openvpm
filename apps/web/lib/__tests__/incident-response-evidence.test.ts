import { describe, expect, it } from "vitest";
import {
  evaluateIncidentResponseEvidence,
  INCIDENT_RESPONSE_SCENARIOS,
} from "../incident-response-evidence";

const now = Date.parse("2026-08-29T21:00:00.000Z");

function healthyEvidence() {
  const scenario = {
    status: "passed",
    detection: true,
    containment: true,
    recovery: true,
    evidenceHandling: true,
    vendorCoordination: true,
    clinicNotificationDecisionRecorded: true,
    legalNotificationDecisionRecorded: true,
  };
  return {
    evidenceFormatVersion: 1,
    exerciseType: "tabletop",
    exerciseId: "tabletop-2026-08-29-deadbeef",
    startedAt: "2026-08-29T19:00:00.000Z",
    completedAt: "2026-08-29T20:00:00.000Z",
    roles: {
      incidentCommander: "@incident-lead",
      privacyLegalReviewer: "@privacy-reviewer",
      notificationAuthority: "@notification-owner",
    },
    approvals: {
      incidentCommander: {
        approver: "@incident-lead",
        approvedAt: "2026-08-29T20:01:00.000Z",
      },
      privacyLegalReviewer: {
        approver: "@privacy-reviewer",
        approvedAt: "2026-08-29T20:02:00.000Z",
      },
      notificationAuthority: {
        approver: "@notification-owner",
        approvedAt: "2026-08-29T20:03:00.000Z",
      },
    },
    scenarios: Object.fromEntries(
      INCIDENT_RESPONSE_SCENARIOS.map((name) => [name, { ...scenario }]),
    ),
    evidenceSafety: {
      phiFree: true,
      secretsFree: true,
      providerPayloadsFree: true,
      localPathsFree: true,
    },
    findings: {
      criticalCount: 0,
      highCount: 1,
      followUpIssueNumbers: [267],
    },
  };
}

describe("incident-response evidence", () => {
  it("accepts a fresh, approved five-scenario tabletop", () => {
    expect(evaluateIncidentResponseEvidence(healthyEvidence(), now)).toEqual({
      ready: true,
      exerciseId: "tabletop-2026-08-29-deadbeef",
      evaluatedAt: "2026-08-29T21:00:00.000Z",
      reasons: [],
    });
  });

  it("rejects placeholder or overlapping role assignments", () => {
    const evidence = healthyEvidence();
    evidence.exerciseId = "replace-tabletop-id";
    evidence.roles.incidentCommander = "@unassigned";
    evidence.roles.notificationAuthority = "@privacy-reviewer";
    const reasons = evaluateIncidentResponseEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Incident-response exercise ID is invalid.",
        "Incident-response role incidentCommander is not assigned.",
        "Incident-response roles must be assigned to distinct people.",
        "Incident-response approval incidentCommander has the wrong approver.",
      ]),
    );
  });

  it("rejects a descriptive exercise identifier", () => {
    const evidence = healthyEvidence();
    evidence.exerciseId = "clinic-name-tabletop-2026-08-29";
    expect(evaluateIncidentResponseEvidence(evidence, now).reasons).toContain(
      "Incident-response exercise ID is invalid.",
    );
  });

  it("requires the opaque exercise identifier date to match completion", () => {
    const evidence = healthyEvidence();
    evidence.exerciseId = "tabletop-2026-08-28-deadbeef";
    expect(evaluateIncidentResponseEvidence(evidence, now).reasons).toContain(
      "Incident-response exercise ID date does not match completion.",
    );
  });

  it("requires tracked follow-up for critical or high findings", () => {
    const evidence = healthyEvidence();
    evidence.findings.followUpIssueNumbers = [];
    expect(evaluateIncidentResponseEvidence(evidence, now).reasons).toContain(
      "Incident-response critical/high findings require a follow-up issue.",
    );
  });

  it("requires approval of the completed exercise", () => {
    const evidence = healthyEvidence();
    evidence.approvals.incidentCommander.approvedAt =
      "2026-08-29T19:30:00.000Z";
    expect(evaluateIncidentResponseEvidence(evidence, now).reasons).toContain(
      "Incident-response approval incidentCommander has an invalid time.",
    );
  });

  it("rejects an incomplete provider scenario", () => {
    const evidence = healthyEvidence();
    evidence.scenarios.stripe.vendorCoordination = false;
    evidence.scenarios.stripe.status = "failed";
    expect(evaluateIncidentResponseEvidence(evidence, now).reasons).toEqual(
      expect.arrayContaining([
        "Incident-response scenario stripe has not passed.",
        "Incident-response scenario stripe is missing vendorCoordination.",
      ]),
    );
  });

  it("rejects extra evidence fields that could carry sensitive notes", () => {
    const evidence = healthyEvidence() as ReturnType<typeof healthyEvidence> & {
      notes?: string;
    };
    evidence.notes = "free-form notes are not release evidence";
    expect(evaluateIncidentResponseEvidence(evidence, now).reasons).toContain(
      "Incident-response evidence has an unexpected root shape.",
    );
  });

  it("rejects stale evidence and unsafe attestations", () => {
    const evidence = healthyEvidence();
    evidence.startedAt = "2026-01-01T19:00:00.000Z";
    evidence.completedAt = "2026-01-01T20:00:00.000Z";
    evidence.evidenceSafety.phiFree = false;
    const reasons = evaluateIncidentResponseEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Incident-response evidence is older than 180 days.",
        "Incident-response evidence is not phiFree.",
      ]),
    );
  });
});
