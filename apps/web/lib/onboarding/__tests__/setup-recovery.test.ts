import { describe, expect, it } from "vitest";
import {
  setupRecoveryAttempt,
  setupRecoveryCopy,
  setupRecoveryDedupeKey,
  setupRecoveryState,
} from "../setup-recovery";

const NOW = new Date("2026-08-11T16:00:00Z");
const TRIAL_END = new Date("2026-08-20T16:00:00Z");

describe("setup recovery policy", () => {
  it("derives the saved stage and authoritative last progress", () => {
    const state = setupRecoveryState(
      {
        onboardingState: {
          onboardingIntent: "replace",
          onboardingIntentSelectedAt: "2026-08-08T12:00:00Z",
          journeyStepId: "data",
          journeyLastProgressAt: "2026-08-09T12:00:00Z",
        },
      },
      "2026-08-07T12:00:00Z",
    );

    expect(state).toEqual({
      completed: false,
      selfHost: false,
      helpRequested: false,
      stage: "data",
      lastProgressAt: new Date("2026-08-09T12:00:00Z"),
    });
    expect(setupRecoveryCopy(state.stage)).toMatchObject({
      stepTitle: "bringing in your clinic records",
    });
  });

  it("maps retired setup chores to the shortened data step", () => {
    expect(
      setupRecoveryState(
        { onboardingState: { journeyStepId: "phone" } },
        "2026-08-07T12:00:00Z",
      ).stage,
    ).toBe("data");
  });

  it("sends the first reminder after one stalled day", () => {
    const state = setupRecoveryState({}, "2026-08-09T12:00:00Z");
    expect(
      setupRecoveryAttempt({
        now: NOW,
        billingStatus: "trialing",
        trialEndsAt: TRIAL_END,
        activated: false,
        state,
        existingEmailCount: 0,
        lastEmailAt: null,
      }),
    ).toBe(1);
  });

  it("waits three stalled days and three days after email one before email two", () => {
    const state = setupRecoveryState({}, "2026-08-01T12:00:00Z");
    const input = {
      now: NOW,
      billingStatus: "trialing",
      trialEndsAt: TRIAL_END,
      activated: false,
      state,
      existingEmailCount: 1,
    } as const;

    expect(
      setupRecoveryAttempt({
        ...input,
        lastEmailAt: "2026-08-09T12:00:00Z",
      }),
    ).toBeNull();
    expect(
      setupRecoveryAttempt({
        ...input,
        lastEmailAt: "2026-08-07T12:00:00Z",
      }),
    ).toBe(2);
  });

  it.each([
    ["completed", { onboardingCompletedAt: "2026-08-10T12:00:00Z" }],
    ["self host", { onboardingState: { onboardingIntent: "self_host" } }],
    [
      "help requested",
      { onboardingState: { setupHelpRequestedAt: "2026-08-10T12:00:00Z" } },
    ],
  ])("does not automate mail when setup is %s", (_label, settings) => {
    expect(
      setupRecoveryAttempt({
        now: NOW,
        billingStatus: "trialing",
        trialEndsAt: TRIAL_END,
        activated: false,
        state: setupRecoveryState(settings, "2026-08-01T12:00:00Z"),
        existingEmailCount: 0,
        lastEmailAt: null,
      }),
    ).toBeNull();
  });

  it("stops after two emails and near trial end", () => {
    const state = setupRecoveryState({}, "2026-08-01T12:00:00Z");
    const base = {
      now: NOW,
      billingStatus: "trialing",
      activated: false,
      state,
      lastEmailAt: "2026-08-07T12:00:00Z",
    };
    expect(
      setupRecoveryAttempt({
        ...base,
        trialEndsAt: TRIAL_END,
        existingEmailCount: 2,
      }),
    ).toBeNull();
    expect(
      setupRecoveryAttempt({
        ...base,
        trialEndsAt: "2026-08-12T12:00:00Z",
        existingEmailCount: 0,
      }),
    ).toBeNull();
  });

  it("uses a bounded campaign-versioned dedupe key", () => {
    expect(
      setupRecoveryDedupeKey("00000000-0000-0000-0000-0000000000aa", 2),
    ).toBe("lc:setup-recovery:v1:00000000-0000-0000-0000-0000000000aa:2");
  });
});
