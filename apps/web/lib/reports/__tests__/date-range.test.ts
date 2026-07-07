import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_RANGE_DAYS,
  defaultReportDateRange,
  isCompleteReportDateRangeInputValid,
  reportPresetDateRange,
  reportDateRangeInputError,
  resolveReportDateRange,
  validateReportDateRangeInput,
  zeroFillDailySeries,
} from "../date-range";

describe("report date ranges", () => {
  it("defaults to the last 30 days including today", () => {
    expect(defaultReportDateRange(new Date("2026-06-27T15:30:00Z"))).toEqual({
      startDate: "2026-05-29",
      endDate: "2026-06-27",
    });
  });

  it("defaults to the practice-local day near UTC midnight", () => {
    expect(
      defaultReportDateRange(
        new Date("2026-07-15T02:30:00Z"),
        "America/Los_Angeles"
      )
    ).toEqual({
      startDate: "2026-06-15",
      endDate: "2026-07-14",
    });
  });

  it("builds practice-local report presets near UTC midnight", () => {
    const now = new Date("2026-07-15T02:30:00Z");
    const timezone = "America/Los_Angeles";

    expect(reportPresetDateRange("month", now, timezone)).toEqual({
      startDate: "2026-07-01",
      endDate: "2026-07-14",
    });
    expect(reportPresetDateRange("lastMonth", now, timezone)).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    expect(reportPresetDateRange("year", now, timezone)).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-07-14",
    });
  });

  it("resolves a custom date range with inclusive day boundaries", () => {
    const range = resolveReportDateRange({
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    });

    expect(range).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-07",
      days: 7,
      previousStartDate: "2026-05-25",
      previousEndDate: "2026-05-31",
    });
    expect(range.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-07T23:59:59.999Z");
    expect(range.endExclusive.toISOString()).toBe("2026-06-08T00:00:00.000Z");
  });

  it("resolves custom date ranges with practice-timezone UTC bounds", () => {
    const range = resolveReportDateRange(
      {
        startDate: "2026-06-01",
        endDate: "2026-06-07",
      },
      new Date("2026-07-15T02:30:00Z"),
      "America/Los_Angeles"
    );

    expect(range).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-07",
      days: 7,
      previousStartDate: "2026-05-25",
      previousEndDate: "2026-05-31",
      timeZone: "America/Los_Angeles",
    });
    expect(range.start.toISOString()).toBe("2026-06-01T07:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-08T06:59:59.999Z");
    expect(range.endExclusive.toISOString()).toBe("2026-06-08T07:00:00.000Z");
    expect(range.previousStart.toISOString()).toBe("2026-05-25T07:00:00.000Z");
    expect(range.previousEndExclusive.toISOString()).toBe(
      "2026-06-01T07:00:00.000Z"
    );
  });

  it("rejects reversed ranges", () => {
    expect(() =>
      resolveReportDateRange({
        startDate: "2026-06-08",
        endDate: "2026-06-07",
      })
    ).toThrow("Start date must be on or before end date");
  });

  it("rejects impossible calendar dates", () => {
    expect(() =>
      resolveReportDateRange({
        startDate: "2026-02-31",
        endDate: "2026-03-02",
      })
    ).toThrow("Start date must be a valid YYYY-MM-DD date");
  });

  it("rejects ranges wider than the reporting limit", () => {
    expect(() =>
      resolveReportDateRange({
        startDate: "2025-01-01",
        endDate: "2026-12-31",
      })
    ).toThrow(`Report date range cannot exceed ${MAX_REPORT_RANGE_DAYS} days`);
  });

  it("validates explicit input without requiring default resolution", () => {
    expect(() =>
      validateReportDateRangeInput({
        startDate: "2026-06-08",
        endDate: "2026-06-07",
      })
    ).toThrow("Start date must be on or before end date");
  });

  it("requires complete valid custom ranges for dashboard controls", () => {
    expect(reportDateRangeInputError({ startDate: "", endDate: "2026-06-07" }))
      .toBe("Start date is required");
    expect(reportDateRangeInputError({ startDate: "2026-06-01", endDate: "" }))
      .toBe("End date is required");
    expect(
      reportDateRangeInputError({
        startDate: "2026-06-08",
        endDate: "2026-06-07",
      })
    ).toBe("Start date must be on or before end date");
    expect(
      isCompleteReportDateRangeInputValid({
        startDate: "2026-06-01",
        endDate: "2026-06-07",
      })
    ).toBe(true);
  });
});

describe("zeroFillDailySeries", () => {
  it("emits one point per day across the range, zeroing missing days", () => {
    const filled = zeroFillDailySeries(
      [{ date: "2026-07-03", amount: 2209.68 }],
      "2026-07-01",
      "2026-07-05"
    );

    expect(filled).toEqual([
      { date: "2026-07-01", amount: 0 },
      { date: "2026-07-02", amount: 0 },
      { date: "2026-07-03", amount: 2209.68 },
      { date: "2026-07-04", amount: 0 },
      { date: "2026-07-05", amount: 0 },
    ]);
  });

  it("crosses month boundaries and preserves existing amounts", () => {
    const filled = zeroFillDailySeries(
      [
        { date: "2026-06-30", amount: 10 },
        { date: "2026-07-01", amount: 20 },
      ],
      "2026-06-29",
      "2026-07-01"
    );

    expect(filled.map((d) => d.date)).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
    ]);
    expect(filled.map((d) => d.amount)).toEqual([0, 10, 20]);
  });

  it("returns a single point for a one-day range", () => {
    expect(zeroFillDailySeries([], "2026-07-04", "2026-07-04")).toEqual([
      { date: "2026-07-04", amount: 0 },
    ]);
  });
});
