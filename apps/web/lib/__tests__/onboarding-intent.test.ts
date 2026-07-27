import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONBOARDING_INTENT,
  getOnboardingIntentOption,
  isOnboardingIntent,
  onboardingIntentLabel,
  ONBOARDING_INTENT_OPTIONS,
} from "../onboarding/intent";

describe("onboarding intent", () => {
  it("defaults to the lower-commitment alongside path", () => {
    expect(DEFAULT_ONBOARDING_INTENT).toBe("alongside");
    expect(getOnboardingIntentOption(DEFAULT_ONBOARDING_INTENT)).toMatchObject({
      recommended: true,
      firstWinTarget: "data",
    });
  });

  it("keeps the four pathways distinct and reports safe labels", () => {
    expect(ONBOARDING_INTENT_OPTIONS.map((option) => option.value)).toEqual([
      "alongside",
      "replace",
      "explore",
      "self_host",
    ]);
    expect(isOnboardingIntent("self_host")).toBe(true);
    expect(isOnboardingIntent("unknown")).toBe(false);
    expect(onboardingIntentLabel("replace")).toBe("Replace current PIMS");
    expect(onboardingIntentLabel("unknown")).toBe("Not selected");
  });
});
