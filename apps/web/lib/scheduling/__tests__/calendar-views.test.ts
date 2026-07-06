import { describe, expect, it } from "vitest";
import {
  addCalendarMonths,
  buildMonthGrid,
  buildWeekDays,
  getCalendarRange,
  groupByCalendarDate,
  startOfWeek,
  toISODate,
} from "../calendar-views";

const localDate = (year: number, monthIndex: number, day: number) =>
  new Date(year, monthIndex, day, 12, 0, 0, 0);

describe("calendar view helpers", () => {
  it("builds a Sunday-start week by default", () => {
    const days = buildWeekDays(localDate(2026, 5, 17));
    expect(days.map((day) => toISODate(day))).toEqual([
      "2026-06-14",
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
    ]);
  });

  it("can build a Monday-start week", () => {
    expect(toISODate(startOfWeek(localDate(2026, 5, 17), 1))).toBe(
      "2026-06-15"
    );
  });

  it("builds a stable six-week month grid with leading and trailing days", () => {
    const grid = buildMonthGrid(localDate(2026, 5, 15));

    expect(grid).toHaveLength(42);
    expect(grid[0]!.dateKey).toBe("2026-05-31");
    expect(grid[41]!.dateKey).toBe("2026-07-11");
    expect(grid.filter((day) => day.isCurrentMonth)).toHaveLength(30);
  });

  it("returns a visible grid range for month queries", () => {
    const range = getCalendarRange(localDate(2026, 5, 15), "month");

    expect(toISODate(range.start)).toBe("2026-05-31");
    expect(range.start.getHours()).toBe(0);
    expect(toISODate(range.end)).toBe("2026-07-11");
    expect(range.end.getHours()).toBe(23);
    expect(range.end.getMinutes()).toBe(59);
    expect(range.end.getMilliseconds()).toBe(999);
  });

  it("clamps month navigation to the target month length", () => {
    expect(toISODate(addCalendarMonths(localDate(2026, 0, 31), 1))).toBe(
      "2026-02-28"
    );
  });

  it("groups records by their local calendar date", () => {
    const grouped = groupByCalendarDate(
      [
        { id: "a", startTime: localDate(2026, 5, 17).toISOString() },
        { id: "b", startTime: localDate(2026, 5, 17).toISOString() },
        { id: "c", startTime: localDate(2026, 5, 18).toISOString() },
      ],
      (item) => item.startTime
    );

    expect(grouped["2026-06-17"]?.map((item) => item.id)).toEqual(["a", "b"]);
    expect(grouped["2026-06-18"]?.map((item) => item.id)).toEqual(["c"]);
  });

  it("groups records by an explicit practice timezone date", () => {
    expect(
      toISODate(new Date("2026-07-15T02:30:00.000Z"), "America/Los_Angeles")
    ).toBe("2026-07-14");

    const grouped = groupByCalendarDate(
      [
        { id: "late", startTime: "2026-07-15T02:30:00.000Z" },
        { id: "morning", startTime: "2026-07-15T15:00:00.000Z" },
      ],
      (item) => item.startTime,
      "America/Los_Angeles"
    );

    expect(grouped["2026-07-14"]?.map((item) => item.id)).toEqual(["late"]);
    expect(grouped["2026-07-15"]?.map((item) => item.id)).toEqual([
      "morning",
    ]);
  });
});
