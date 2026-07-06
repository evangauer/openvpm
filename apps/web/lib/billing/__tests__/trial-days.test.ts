import { describe, expect, it } from "vitest";
import { trialCalendarDaysLeft } from "../trial-days";

describe("trialCalendarDaysLeft", () => {
  it("counts practice-local calendar days instead of exact 24-hour blocks", () => {
    expect(
      trialCalendarDaysLeft(
        new Date("2026-07-04T02:00:00.000Z"),
        "America/Los_Angeles",
        new Date("2026-07-01T23:30:00.000Z")
      )
    ).toBe(2);
  });

  it("falls back to UTC when no valid practice timezone is available", () => {
    const trialEnd = new Date("2026-07-04T02:00:00.000Z");
    const now = new Date("2026-07-01T23:30:00.000Z");

    expect(trialCalendarDaysLeft(trialEnd, null, now)).toBe(3);
    expect(trialCalendarDaysLeft(trialEnd, "Not/AZone", now)).toBe(3);
  });

  it("returns null for missing or invalid trial ends and clamps elapsed trials", () => {
    expect(trialCalendarDaysLeft(null, "America/New_York")).toBeNull();
    expect(trialCalendarDaysLeft("not-a-date", "America/New_York")).toBeNull();
    expect(
      trialCalendarDaysLeft(
        new Date("2026-07-01T12:00:00.000Z"),
        "America/New_York",
        new Date("2026-07-02T12:00:00.000Z")
      )
    ).toBe(0);
  });
});
