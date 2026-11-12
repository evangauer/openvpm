import { describe, expect, it } from "vitest";
import {
  computeOccurrenceDate,
  recurrenceDateInput,
  resolveRecurrenceTimeZone,
} from "../recurrence";

const NY = "America/New_York";

function series(
  dateInput: string,
  frequency: "weekly" | "monthly" | "annual",
  count: number,
  interval = 1,
): string[] {
  return Array.from({ length: count }, (_, n) =>
    recurrenceDateInput(dateInput, frequency, interval, n),
  );
}

function localWallClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(date)
    .replace(",", "");
}

describe("recurrenceDateInput", () => {
  it("clamps a monthly series to each month's last day without drifting", () => {
    expect(series("2026-12-31", "monthly", 5)).toEqual([
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);
  });

  it("uses Feb 29 for a month-end monthly series in a leap year", () => {
    expect(series("2028-01-31", "monthly", 3)).toEqual([
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
    ]);
  });

  it("keeps a mid-month day unchanged", () => {
    expect(series("2026-01-15", "monthly", 3)).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
    ]);
  });

  it("clamps the 30th and 29th only where the month is shorter", () => {
    expect(series("2027-01-30", "monthly", 3)).toEqual([
      "2027-01-30",
      "2027-02-28",
      "2027-03-30",
    ]);
    expect(series("2027-01-29", "monthly", 3)).toEqual([
      "2027-01-29",
      "2027-02-28",
      "2027-03-29",
    ]);
  });

  it("applies the interval across year boundaries", () => {
    expect(series("2026-08-31", "monthly", 4, 3)).toEqual([
      "2026-08-31",
      "2026-11-30",
      "2027-02-28",
      "2027-05-31",
    ]);
  });

  it("moves an annual Feb 29 series to Feb 28 in common years and back in leap years", () => {
    expect(series("2028-02-29", "annual", 5)).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
  });

  it("handles an every-other-year interval", () => {
    expect(series("2024-02-29", "annual", 3, 2)).toEqual([
      "2024-02-29",
      "2026-02-28",
      "2028-02-29",
    ]);
  });

  it("adds whole weeks across month and year ends", () => {
    expect(series("2026-12-24", "weekly", 3)).toEqual([
      "2026-12-24",
      "2026-12-31",
      "2027-01-07",
    ]);
    expect(series("2028-02-22", "weekly", 3, 2)).toEqual([
      "2028-02-22",
      "2028-03-07",
      "2028-03-21",
    ]);
  });
});

describe("computeOccurrenceDate", () => {
  it("keeps a weekly visit at the same local time across the spring DST change", () => {
    // 9:00 AM EST on Mar 1, 2026; DST starts Mar 8, 2026.
    const base = new Date("2026-03-01T14:00:00Z");
    const occurrences = [0, 1, 2].map((n) =>
      computeOccurrenceDate(base, "weekly", 1, n, NY),
    );

    expect(occurrences.map((d) => d.toISOString())).toEqual([
      "2026-03-01T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-15T13:00:00.000Z",
    ]);
    expect(occurrences.map((d) => localWallClock(d, NY))).toEqual([
      "2026-03-01 09:00",
      "2026-03-08 09:00",
      "2026-03-15 09:00",
    ]);
  });

  it("keeps a weekly visit at the same local time across the fall DST change", () => {
    // 4:30 PM EDT on Oct 25, 2026; DST ends Nov 1, 2026.
    const base = new Date("2026-10-25T20:30:00Z");
    const occurrences = [0, 1, 2].map((n) =>
      computeOccurrenceDate(base, "weekly", 1, n, NY),
    );

    expect(occurrences.map((d) => d.toISOString())).toEqual([
      "2026-10-25T20:30:00.000Z",
      "2026-11-01T21:30:00.000Z",
      "2026-11-08T21:30:00.000Z",
    ]);
    expect(occurrences.map((d) => localWallClock(d, NY))).toEqual([
      "2026-10-25 16:30",
      "2026-11-01 16:30",
      "2026-11-08 16:30",
    ]);
  });

  it("shifts a time skipped by spring-forward later by the gap, then resumes", () => {
    // 2:30 AM does not exist in New York on Mar 8, 2026.
    const base = new Date("2026-03-01T07:30:00Z"); // 2:30 AM EST
    const occurrences = [0, 1, 2].map((n) =>
      computeOccurrenceDate(base, "weekly", 1, n, NY),
    );

    expect(occurrences.map((d) => localWallClock(d, NY))).toEqual([
      "2026-03-01 02:30",
      "2026-03-08 03:30",
      "2026-03-15 02:30",
    ]);
  });

  it("uses the first of two repeated fall-back times", () => {
    // 1:30 AM happens twice in New York on Nov 1, 2026.
    const base = new Date("2026-10-25T05:30:00Z"); // 1:30 AM EDT
    expect(
      computeOccurrenceDate(base, "weekly", 1, 1, NY).toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z"); // 1:30 AM EDT, not EST
  });

  it("moves a monthly visit that lands in the spring-forward gap later by the gap", () => {
    // Monthly on the 8th at 2:30 AM; Mar 8, 2026 has no 2:30 AM in New York.
    const base = new Date("2026-02-08T07:30:00Z"); // 2:30 AM EST
    const occurrences = [0, 1, 2].map((n) =>
      computeOccurrenceDate(base, "monthly", 1, n, NY),
    );

    expect(occurrences.map((d) => localWallClock(d, NY))).toEqual([
      "2026-02-08 02:30",
      "2026-03-08 03:30",
      "2026-04-08 02:30",
    ]);
    expect(occurrences[1]!.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("uses the first repeated time for a monthly visit that lands in the fall-back overlap", () => {
    // Monthly on the 1st at 1:30 AM; 1:30 AM happens twice on Nov 1, 2026.
    const base = new Date("2026-10-01T05:30:00Z"); // 1:30 AM EDT
    const occurrences = [1, 2].map((n) =>
      computeOccurrenceDate(base, "monthly", 1, n, NY),
    );

    expect(occurrences.map((d) => d.toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z", // 1:30 AM EDT (first)
      "2026-12-01T06:30:00.000Z", // 1:30 AM EST
    ]);
  });

  it("keeps the local time of a series that starts in the second repeated hour", () => {
    // 1:30 AM EST, the second 1:30 AM on Nov 1, 2026.
    const base = new Date("2026-11-01T06:30:00Z");
    const occurrences = [0, 1, 2].map((n) =>
      computeOccurrenceDate(base, "weekly", 1, n, NY),
    );

    // The booked first visit is kept exactly, not moved to the first 1:30 AM.
    expect(occurrences[0]!.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(occurrences.map((d) => localWallClock(d, NY))).toEqual([
      "2026-11-01 01:30",
      "2026-11-08 01:30",
      "2026-11-15 01:30",
    ]);
  });

  it("handles southern-hemisphere DST gaps and overlaps", () => {
    const sydney = "Australia/Sydney";
    // Oct 4, 2026: 2:00 AM jumps to 3:00 AM.
    const gapBase = new Date("2026-09-26T16:30:00Z"); // Sep 27 2:30 AM AEST
    expect(
      [0, 1, 2].map((n) =>
        localWallClock(
          computeOccurrenceDate(gapBase, "weekly", 1, n, sydney),
          sydney,
        ),
      ),
    ).toEqual(["2026-09-27 02:30", "2026-10-04 03:30", "2026-10-11 02:30"]);

    // Apr 5, 2026: 3:00 AM falls back to 2:00 AM, so 2:30 AM happens twice.
    const overlapBase = new Date("2026-03-28T15:30:00Z"); // Mar 29 2:30 AM AEDT
    expect(
      computeOccurrenceDate(overlapBase, "weekly", 1, 1, sydney).toISOString(),
    ).toBe("2026-04-04T15:30:00.000Z"); // 2:30 AM AEDT (first)
  });

  it("shifts by a half-hour DST gap", () => {
    const lordHowe = "Australia/Lord_Howe";
    // Oct 4, 2026: 2:00 AM jumps to 2:30 AM.
    const base = new Date("2026-09-26T15:45:00Z"); // Sep 27 2:15 AM (+10:30)
    expect(
      [0, 1].map((n) =>
        localWallClock(
          computeOccurrenceDate(base, "weekly", 1, n, lordHowe),
          lordHowe,
        ),
      ),
    ).toEqual(["2026-09-27 02:15", "2026-10-04 02:45"]);
  });

  it("clamps month ends on the practice's local calendar, not UTC", () => {
    // 8:00 PM EST on Dec 31, 2026 is already Jan 1 in UTC.
    const base = new Date("2027-01-01T01:00:00Z");
    const occurrences = [0, 1, 2, 3].map((n) =>
      computeOccurrenceDate(base, "monthly", 1, n, NY),
    );

    expect(occurrences.map((d) => localWallClock(d, NY))).toEqual([
      "2026-12-31 20:00",
      "2027-01-31 20:00",
      "2027-02-28 20:00",
      // Crosses the Mar 14, 2027 DST change and stays at 8:00 PM.
      "2027-03-31 20:00",
    ]);
  });

  it("moves a local Feb 29 annual visit to Feb 28 at the same local time", () => {
    const base = new Date("2028-02-29T15:15:00Z"); // 10:15 AM EST
    const occurrences = [0, 1, 4].map((n) =>
      computeOccurrenceDate(base, "annual", 1, n, NY),
    );

    expect(occurrences.map((d) => localWallClock(d, NY))).toEqual([
      "2028-02-29 10:15",
      "2029-02-28 10:15",
      "2032-02-29 10:15",
    ]);
  });

  it("falls back to UTC for a missing or invalid practice timezone", () => {
    expect(resolveRecurrenceTimeZone(undefined)).toBe("UTC");
    expect(resolveRecurrenceTimeZone("Not/AZone")).toBe("UTC");
    expect(
      computeOccurrenceDate(
        new Date("2026-12-31T09:00:00Z"),
        "monthly",
        1,
        2,
        "Not/AZone",
      ).toISOString(),
    ).toBe("2027-02-28T09:00:00.000Z");
  });
});
