import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkoutRecoveryConfig,
  checkoutRecoveryDedupeKey,
  checkoutRecoveryStepDue,
  greetingName,
  isStopReason,
} from "../checkout-recovery";

const HOUR = 60 * 60 * 1000;
const createdAt = new Date("2026-11-04T18:47:00Z");
const at = (hours: number) => new Date(createdAt.getTime() + hours * HOUR);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkoutRecoveryConfig", () => {
  it("is off unless explicitly enabled", () => {
    expect(checkoutRecoveryConfig()).toEqual({
      enabled: false,
      reason: "disabled",
    });
  });

  it("requires a valid prospective rollout timestamp", () => {
    vi.stubEnv("CHECKOUT_RECOVERY_ENABLED", "true");
    expect(checkoutRecoveryConfig()).toEqual({
      enabled: false,
      reason: "rollout_at_invalid",
    });
    vi.stubEnv("CHECKOUT_RECOVERY_ROLLOUT_AT", "2026-11-01T00:00:00Z");
    expect(checkoutRecoveryConfig()).toEqual({
      enabled: true,
      rolloutAt: new Date("2026-11-01T00:00:00Z"),
    });
  });
});

describe("checkoutRecoveryStepDue", () => {
  const base = {
    createdAt,
    existingEmailCount: 0,
    lastEmailAt: null,
    recipientVerified: true,
  };

  it("waits an hour, then sends step 1", () => {
    expect(checkoutRecoveryStepDue({ ...base, now: at(0.5) })).toBeNull();
    expect(checkoutRecoveryStepDue({ ...base, now: at(1) })).toBe(1);
  });

  it("follows the schedule and enforces the minimum gap", () => {
    expect(
      checkoutRecoveryStepDue({
        ...base,
        now: at(23),
        existingEmailCount: 1,
        lastEmailAt: at(1),
      }),
    ).toBeNull();
    expect(
      checkoutRecoveryStepDue({
        ...base,
        now: at(24),
        existingEmailCount: 1,
        lastEmailAt: at(1),
      }),
    ).toBe(2);
    // A late first send pushes step 2 out by the minimum gap.
    expect(
      checkoutRecoveryStepDue({
        ...base,
        now: at(30),
        existingEmailCount: 1,
        lastEmailAt: at(20),
      }),
    ).toBeNull();
    expect(
      checkoutRecoveryStepDue({
        ...base,
        now: at(240),
        existingEmailCount: 3,
        lastEmailAt: at(72),
      }),
    ).toBe(4);
  });

  it("stops after the last step and for stale registrations", () => {
    expect(
      checkoutRecoveryStepDue({
        ...base,
        now: at(300),
        existingEmailCount: 4,
        lastEmailAt: at(240),
      }),
    ).toBeNull();
    expect(
      checkoutRecoveryStepDue({ ...base, now: at(31 * 24) }),
    ).toBeNull();
  });

  it("sends an unverified address only the first two emails", () => {
    const unverified = { ...base, recipientVerified: false };
    expect(
      checkoutRecoveryStepDue({
        ...unverified,
        now: at(24),
        existingEmailCount: 1,
        lastEmailAt: at(1),
      }),
    ).toBe(2);
    expect(
      checkoutRecoveryStepDue({
        ...unverified,
        now: at(72),
        existingEmailCount: 2,
        lastEmailAt: at(24),
      }),
    ).toBeNull();
  });
});

describe("helpers", () => {
  it("versions dedupe keys per practice and step", () => {
    expect(checkoutRecoveryDedupeKey("p-1", 3)).toBe(
      "lc:checkout-recovery:v1:p-1:3",
    );
  });

  it("validates stop reasons", () => {
    expect(isStopReason("card")).toBe(true);
    expect(isStopReason("spam")).toBe(false);
    expect(isStopReason(undefined)).toBe(false);
  });

  it("greets by first name only", () => {
    expect(greetingName("  Sam Rivera ")).toBe("Sam");
    expect(greetingName("")).toBeNull();
    expect(greetingName(null)).toBeNull();
  });
});
