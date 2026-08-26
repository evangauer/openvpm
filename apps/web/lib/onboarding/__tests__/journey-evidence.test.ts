import { describe, expect, it } from "vitest";
import {
  boundedJourneyTimestamp,
  journeyTransitionStage,
  onboardingJourneyEvidenceMode,
  onboardingJourneyRevision,
  orderedProspectiveJourneyEvidence,
  prospectivePredecessorIsValid,
} from "../journey-evidence";

const CREATED_AT = new Date("2026-08-25T12:00:00.000Z");
const NOW = new Date("2026-08-25T13:00:00.000Z");

describe("onboarding journey evidence contract", () => {
  it("derives evidence mode only from the explicit version marker", () => {
    expect(onboardingJourneyEvidenceMode(undefined)).toBe("legacy");
    expect(
      onboardingJourneyEvidenceMode({
        journeyIntentCompletedAt: "2026-08-25T12:01:00.000Z",
        journeyBasicsCompletedAt: "2026-08-25T12:02:00.000Z",
      }),
    ).toBe("legacy");
    expect(onboardingJourneyEvidenceMode({ journeyEvidenceVersion: 1 })).toBe(
      "prospective",
    );
    expect(onboardingJourneyEvidenceMode({ journeyEvidenceVersion: 2 })).toBe(
      "invalid",
    );
  });

  it("defaults only a missing revision to zero and rejects malformed revisions", () => {
    expect(onboardingJourneyRevision(undefined)).toEqual({
      revision: 0,
      valid: true,
    });
    expect(onboardingJourneyRevision({ journeyRevision: 3 })).toEqual({
      revision: 3,
      valid: true,
    });
    for (const value of [-1, 1.5, "2", Number.NaN, 2_147_483_647]) {
      expect(onboardingJourneyRevision({ journeyRevision: value }).valid).toBe(
        false,
      );
    }
  });

  it("allows only the reviewed incomplete adjacency and dismissal transitions", () => {
    const allowed = [
      [null, "intent", undefined],
      ["intent", "intent", true],
      ["intent", "basics", false],
      ["basics", "intent", false],
      ["basics", "data", false],
      ["data", "basics", false],
      ["data", "allSet", false],
      ["allSet", "data", false],
      ["allSet", "allSet", true],
    ] as const;
    for (const [currentStepId, targetStepId, dismissed] of allowed) {
      expect(
        journeyTransitionStage({
          currentStepId,
          targetStepId,
          dismissed,
          durableIntent: true,
        }),
      ).not.toBeUndefined();
    }

    expect(
      journeyTransitionStage({
        currentStepId: null,
        targetStepId: "basics",
        dismissed: false,
        durableIntent: true,
      }),
    ).toBeUndefined();
    expect(
      journeyTransitionStage({
        currentStepId: "intent",
        targetStepId: "basics",
        dismissed: false,
        durableIntent: false,
      }),
    ).toBeUndefined();
    expect(
      journeyTransitionStage({
        currentStepId: "intent",
        targetStepId: "data",
        dismissed: false,
        durableIntent: true,
      }),
    ).toBeUndefined();
    expect(
      journeyTransitionStage({
        currentStepId: "basics",
        targetStepId: "data",
        dismissed: true,
        durableIntent: true,
      }),
    ).toBeUndefined();
  });

  it("requires prospective timestamps to be bounded and ordered", () => {
    const state = {
      journeyIntentCompletedAt: "2026-08-25T12:01:00.000Z",
      journeyBasicsCompletedAt: "2026-08-25T12:02:00.000Z",
      journeyDataCompletedAt: "2026-08-25T12:03:00.000Z",
      journeyAllSetCompletedAt: "2026-08-25T12:04:00.000Z",
    };
    expect(orderedProspectiveJourneyEvidence(state, CREATED_AT, NOW)).toEqual({
      intent: true,
      basics: true,
      data: true,
      allSet: true,
    });
    expect(
      boundedJourneyTimestamp("2026-08-25T11:59:59.999Z", CREATED_AT, NOW),
    ).toBe(false);

    const outOfOrder = orderedProspectiveJourneyEvidence(
      {
        ...state,
        journeyBasicsCompletedAt: "2026-08-25T12:00:30.000Z",
      },
      CREATED_AT,
      NOW,
    );
    expect(outOfOrder).toEqual({
      intent: true,
      basics: false,
      data: false,
      allSet: false,
    });
  });

  it("validates the predecessor before accepting a first-write stage time", () => {
    const evidence = {
      intent: true,
      basics: true,
      data: false,
      allSet: false,
    };
    expect(
      prospectivePredecessorIsValid({
        completedStage: "data",
        evidence,
        existingStageTimestamp: null,
      }),
    ).toBe(true);
    expect(
      prospectivePredecessorIsValid({
        completedStage: "data",
        evidence,
        existingStageTimestamp: "malformed-existing-value",
      }),
    ).toBe(false);
  });
});
