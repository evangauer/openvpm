import { describe, expect, it } from "vitest";
import {
  calculatePortalAge,
  formatPortalDate,
  formatPortalDateTime,
  formatPortalDateInput,
  formatPortalDateInputLocal,
  parsePortalDate,
  portalCalendarDayDifference,
} from "../date";

describe("portal date helpers", () => {
  it("parses YYYY-MM-DD values as local calendar dates", () => {
    const parsed = parsePortalDate("2026-06-01");

    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(5);
    expect(parsed?.getDate()).toBe(1);
    expect(formatPortalDate("2026-06-01", "US")).toBe("Jun 1, 2026");
  });

  it("formats date input values from the local calendar day", () => {
    expect(formatPortalDateInputLocal(new Date(2026, 5, 1, 23, 30))).toBe(
      "2026-06-01"
    );
  });

  it("formats date input values from the practice timezone day", () => {
    expect(
      formatPortalDateInput(
        new Date("2026-07-01T04:30:00.000Z"),
        "America/Los_Angeles"
      )
    ).toBe("2026-06-30");
  });

  it("rejects impossible date-only values before display", () => {
    expect(parsePortalDate("2026-02-31")).toBeNull();
    expect(formatPortalDate("2026-02-31")).toBe("N/A");
  });

  it("formats instant dates in an explicit practice timezone without shifting date-only values", () => {
    expect(
      formatPortalDate(
        "2026-07-01T04:30:00.000Z",
        "US",
        "America/Los_Angeles"
      )
    ).toBe("Jun 30, 2026");
    expect(formatPortalDate("2026-07-01", "US", "America/Los_Angeles")).toBe(
      "Jul 1, 2026"
    );
  });

  it("formats appointment instants in an explicit practice timezone", () => {
    const label = formatPortalDateTime(
      "2026-07-01T16:00:00.000Z",
      "US",
      "America/Los_Angeles"
    );

    expect(label).toContain("Wed, Jul 1, 2026");
    expect(label).toContain("9:00 AM");
    expect(formatPortalDateTime("not-a-date", "US", "America/New_York")).toBe(
      "N/A"
    );
  });

  it("compares date-only due dates by calendar day", () => {
    const lateToday = new Date(2026, 5, 1, 23, 30);

    expect(portalCalendarDayDifference("2026-06-01", lateToday)).toBe(0);
    expect(portalCalendarDayDifference("2026-05-31", lateToday)).toBe(-1);
    expect(portalCalendarDayDifference("2026-06-30", lateToday)).toBe(29);
  });

  it("compares date-only due dates by practice timezone day", () => {
    const earlyUtc = new Date("2026-07-01T04:30:00.000Z");

    expect(
      portalCalendarDayDifference(
        "2026-06-30",
        earlyUtc,
        "America/Los_Angeles"
      )
    ).toBe(0);
    expect(
      portalCalendarDayDifference(
        "2026-07-01",
        earlyUtc,
        "America/Los_Angeles"
      )
    ).toBe(1);
    expect(
      portalCalendarDayDifference("not-a-date", earlyUtc, "America/Los_Angeles")
    ).toBeNull();
  });

  it("calculates pet ages from date-only birthdays without timezone drift", () => {
    expect(calculatePortalAge("2025-06-30", new Date(2026, 5, 29))).toBe(
      "11 months old"
    );
    expect(calculatePortalAge("2025-06-30", new Date(2026, 5, 30))).toBe(
      "1 year old"
    );
  });
});
