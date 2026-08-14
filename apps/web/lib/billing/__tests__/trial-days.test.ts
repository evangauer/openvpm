import { describe, expect, it } from "vitest";
import { trialCalendarDaysLeft, trialEndOfCalendarDay } from "../trial-days";

describe("trialCalendarDaysLeft", () => {
  it("keeps a fourteen-day trial through the final clinic calendar day", () => {
    const start = new Date("2026-08-13T23:17:00.000Z");
    const end = trialEndOfCalendarDay(14, "America/New_York", start);

    expect(end.toISOString()).toBe("2026-08-28T03:59:59.000Z");
    expect(trialCalendarDaysLeft(end, "America/New_York", start)).toBe(14);
  });
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
