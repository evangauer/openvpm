import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONBOARDING_INTENT,
  getOnboardingIntentOption,
  HOSTED_CLINIC_PILOT,
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

  it("qualifies the hosted clinic pilot without overstating readiness", () => {
    expect(HOSTED_CLINIC_PILOT.recommendedFit).toContain(
      "companion-animal clinic",
    );
    expect(HOSTED_CLINIC_PILOT.firstUsefulDay).toContain(
      "one real client and pet",
    );
    expect(HOSTED_CLINIC_PILOT.guardrails).toEqual(
      expect.arrayContaining([
        expect.stringContaining("current PIMS as the source of truth"),
        expect.stringContaining("offline changes stay only in the current tab"),
        expect.stringContaining(
          "Texting requires separate controlled activation",
        ),
        expect.stringContaining("large-animal workflows"),
        expect.stringContaining("third-party integrations"),
      ]),
    );
  });
});
