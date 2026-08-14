import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_CLINIC_WIN_ENABLED_ENV,
  FIRST_CLINIC_WIN_ROLLOUT_AT_ENV,
  firstClinicWinConfig,
} from "../first-clinic-win";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("first clinic win rollout", () => {
  it("is default-off", () => {
    expect(firstClinicWinConfig()).toEqual({
      enabled: false,
      reason: "disabled",
    });
  });

  it("fails closed without an exact prospective launch timestamp", () => {
    vi.stubEnv(FIRST_CLINIC_WIN_ENABLED_ENV, "true");
    vi.stubEnv(FIRST_CLINIC_WIN_ROLLOUT_AT_ENV, "not-a-date");

    expect(firstClinicWinConfig()).toEqual({
      enabled: false,
      reason: "rollout_at_invalid",
    });
  });

  it("returns the configured prospective launch boundary", () => {
    vi.stubEnv(FIRST_CLINIC_WIN_ENABLED_ENV, "true");
    vi.stubEnv(FIRST_CLINIC_WIN_ROLLOUT_AT_ENV, "2026-08-15T12:00:00Z");

    expect(firstClinicWinConfig()).toEqual({
      enabled: true,
      rolloutAt: new Date("2026-08-15T12:00:00Z"),
    });
  });
});
