import { describe, expect, it } from "vitest";
import {
  AUTH_RECOVERY_DRILL_CONTROLS,
  evaluateAuthRecoveryEvidence,
} from "../auth-recovery-evidence";

const now = Date.parse("2026-08-30T03:00:00.000Z");

function healthyEvidence() {
  return {
    evidenceFormatVersion: 1,
    drillId: "auth-recovery-2026-08-30-deadbeef",
    startedAt: "2026-08-30T01:00:00.000Z",
    completedAt: "2026-08-30T02:00:00.000Z",
    policy: {
      version: "dual-control-v1",
      sha256: "a".repeat(64),
      approvedBy: "@owner-reviewer",
      approvedAt: "2026-08-29T20:00:00.000Z",
    },
    authorities: ["@recovery-one", "@recovery-two"],
    operators: {
      requester: "@recovery-one",
      approver: "@recovery-two",
    },
    controls: Object.fromEntries(
      AUTH_RECOVERY_DRILL_CONTROLS.map((control) => [control, true]),
    ) as Record<(typeof AUTH_RECOVERY_DRILL_CONTROLS)[number], boolean>,
    evidenceSafety: {
      emailAddressesFree: true,
      localPathsFree: true,
      phiFree: true,
      secretsFree: true,
    },
    findings: {
      criticalCount: 0,
      highCount: 0,
      followUpIssueNumbers: [] as number[],
    },
  };
}

describe("account-recovery drill evidence", () => {
  it("accepts a fresh dual-control drill with every recovery invariant", () => {
    expect(evaluateAuthRecoveryEvidence(healthyEvidence(), now)).toEqual({
      ready: true,
      drillId: "auth-recovery-2026-08-30-deadbeef",
      evaluatedAt: "2026-08-30T03:00:00.000Z",
      reasons: [],
    });
  });

  it("rejects self-approval and unlisted operators", () => {
    const evidence = healthyEvidence();
    evidence.operators.approver = "@recovery-one";
    expect(evaluateAuthRecoveryEvidence(evidence, now).reasons).toContain(
      "Account-recovery request and approval require distinct named authorities.",
    );
    evidence.operators.approver = "@outside-operator";
    expect(evaluateAuthRecoveryEvidence(evidence, now).ready).toBe(false);
  });

  it("rejects any unproven revocation, one-use, or anti-bypass control", () => {
    for (const control of [
      "priorSessionsRevoked",
      "priorPasskeysRetired",
      "recoveryGrantSingleUse",
      "emailOnlyRecoveryRejected",
    ] as const) {
      const evidence = healthyEvidence();
      evidence.controls[control] = false;
      expect(evaluateAuthRecoveryEvidence(evidence, now).reasons).toContain(
        `Account-recovery drill did not prove ${control}.`,
      );
    }
  });

  it("rejects stale, placeholder, unsafe, and free-form evidence", () => {
    const evidence = healthyEvidence() as ReturnType<typeof healthyEvidence> & {
      notes?: string;
    };
    evidence.completedAt = "2026-01-01T02:00:00.000Z";
    evidence.startedAt = "2026-01-01T01:00:00.000Z";
    evidence.authorities[0] = "@unassigned";
    evidence.evidenceSafety.phiFree = false;
    evidence.notes = "free text is prohibited";
    const reasons = evaluateAuthRecoveryEvidence(evidence, now).reasons;
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Account-recovery evidence has an unexpected root shape.",
        "Account-recovery evidence is older than 90 days.",
        "Account-recovery authorities must name two to five distinct people.",
        "Account-recovery evidence is not phiFree.",
      ]),
    );
  });

  it("requires critical/high findings to be tracked", () => {
    const evidence = healthyEvidence();
    evidence.findings.highCount = 1;
    expect(evaluateAuthRecoveryEvidence(evidence, now).reasons).toContain(
      "Account-recovery critical/high findings require a follow-up issue.",
    );
  });
});
