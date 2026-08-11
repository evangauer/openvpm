import { describe, expect, it } from "vitest";
import {
  ONBOARDING_JOURNEY_STEPS,
  onboardingJourneyResumeIndex,
} from "@/lib/onboarding/journey-plan";

describe("onboarding journey plan", () => {
  it("keeps the guided path focused on the first real clinic action", () => {
    expect(ONBOARDING_JOURNEY_STEPS.map((step) => step.id)).toEqual([
      "intent",
      "basics",
      "data",
      "allSet",
    ]);
  });

  it("resumes a current step exactly", () => {
    expect(
      onboardingJourneyResumeIndex({
        onboardingIntent: "alongside",
        journeyStepId: "data",
        migrationHasCommittedChanges: false,
      }),
    ).toBe(2);
  });

  it("moves retired chores to real data without restarting setup", () => {
    expect(
      onboardingJourneyResumeIndex({
        onboardingIntent: "replace",
        journeyStepId: "phone",
        migrationHasCommittedChanges: false,
      }),
    ).toBe(2);
  });

  it("moves a legacy clinic with committed data to the first-day handoff", () => {
    expect(
      onboardingJourneyResumeIndex({
        onboardingIntent: "replace",
        journeyStepId: "billing",
        migrationHasCommittedChanges: true,
      }),
    ).toBe(3);
  });

  it("still asks for a path when no intent was durably saved", () => {
    expect(
      onboardingJourneyResumeIndex({
        onboardingIntent: null,
        journeyStepId: "allSet",
        migrationHasCommittedChanges: true,
      }),
    ).toBe(0);
  });
});
