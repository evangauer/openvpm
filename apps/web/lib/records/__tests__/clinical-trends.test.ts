import { describe, expect, it } from "vitest";
import {
  buildLabTrends,
  buildVitalTrend,
  buildWeightTrend,
  hasTrendValues,
  parseClinicalNumber,
} from "../clinical-trends";

describe("clinical trend helpers", () => {
  it("parses numeric values from database strings", () => {
    expect(parseClinicalNumber("12.340")).toBe(12.34);
    expect(parseClinicalNumber(98)).toBe(98);
    expect(parseClinicalNumber("")).toBeNull();
    expect(parseClinicalNumber("not-a-number")).toBeNull();
  });

  it("builds weight trend points in chronological order", () => {
    const trend = buildWeightTrend([
      { recordedAt: "2026-06-03T12:00:00Z", weightKg: "12.5" },
      { recordedAt: "2026-06-01T12:00:00Z", weightKg: "11.9" },
      { recordedAt: "bad-date", weightKg: "14" },
      { recordedAt: "2026-06-02T12:00:00Z", weightKg: null },
    ]);

    expect(trend.map((point) => point.date)).toEqual([
      "2026-06-01",
      "2026-06-03",
    ]);
    expect(trend.map((point) => point.weightKg)).toEqual([11.9, 12.5]);
  });

  it("builds trend points from practice-local date keys", () => {
    const weights = buildWeightTrend(
      [{ recordedAt: "2026-07-01T04:30:00.000Z", weightKg: "12.5" }],
      "America/Los_Angeles"
    );
    const vitals = buildVitalTrend(
      [{ recordedAt: "2026-07-01T04:30:00.000Z", temperatureC: "38.4" }],
      "America/Los_Angeles"
    );

    expect(weights).toMatchObject([{ date: "2026-06-30", dateLabel: "Jun 30" }]);
    expect(vitals).toMatchObject([{ date: "2026-06-30", dateLabel: "Jun 30" }]);
  });

  it("builds vital trend points and keeps sparse metrics as nulls", () => {
    const trend = buildVitalTrend([
      {
        recordedAt: "2026-06-02T12:00:00Z",
        temperatureC: "38.4",
        heartRateBpm: 112,
        respiratoryRateBpm: null,
        weightKg: "8.250",
      },
      {
        recordedAt: "2026-06-01T12:00:00Z",
        painScore: "4",
        bodyConditionScore: "5",
      },
    ]);

    expect(trend).toMatchObject([
      {
        date: "2026-06-01",
        temperatureC: null,
        painScore: 4,
        bodyConditionScore: 5,
      },
      {
        date: "2026-06-02",
        temperatureC: 38.4,
        heartRateBpm: 112,
        respiratoryRateBpm: null,
        weightKg: 8.25,
      },
    ]);
  });

  it("builds lab trends for repeated numeric tests with matching units", () => {
    const trends = buildLabTrends([
      {
        testName: "ALT",
        unit: "U/L",
        resultValue: "62",
        referenceRangeLow: "10",
        referenceRangeHigh: "90",
        createdAt: "2026-06-03T12:00:00Z",
      },
      {
        testName: " ALT ",
        unit: "U/L",
        resultValue: "75.5",
        referenceRangeLow: "10",
        referenceRangeHigh: "90",
        createdAt: "2026-06-01T12:00:00Z",
      },
      {
        testName: "ALT",
        unit: "mg/dL",
        resultValue: "4",
        createdAt: "2026-06-02T12:00:00Z",
      },
      {
        testName: "Glucose",
        unit: "mg/dL",
        resultValue: "high",
        createdAt: "2026-06-02T12:00:00Z",
      },
    ]);

    expect(trends).toHaveLength(1);
    expect(trends[0]).toMatchObject({
      testName: "ALT",
      unit: "U/L",
      latestValue: 62,
      previousValue: 75.5,
      change: -13.5,
    });
    expect(trends[0]!.points.map((point) => point.date)).toEqual([
      "2026-06-01",
      "2026-06-03",
    ]);
    expect(trends[0]!.points[1]).toMatchObject({
      referenceRangeLow: 10,
      referenceRangeHigh: 90,
    });
  });

  it("builds lab trend dates in the practice timezone", () => {
    const trends = buildLabTrends(
      [
        {
          testName: "Creatinine",
          unit: "mg/dL",
          resultValue: "1.2",
          createdAt: "2026-07-01T04:30:00.000Z",
        },
        {
          testName: "Creatinine",
          unit: "mg/dL",
          resultValue: "1.4",
          createdAt: "2026-07-02T04:30:00.000Z",
        },
      ],
      "America/Los_Angeles"
    );

    expect(trends[0]!.points).toMatchObject([
      { date: "2026-06-30", dateLabel: "Jun 30" },
      { date: "2026-07-01", dateLabel: "Jul 1" },
    ]);
  });

  it("detects whether a chart has at least one numeric metric", () => {
    expect(
      hasTrendValues([{ weightKg: null }, { weightKg: 4.2 }], ["weightKg"])
    ).toBe(true);
    expect(
      hasTrendValues([{ weightKg: null }, { weightKg: undefined }], [
        "weightKg",
      ])
    ).toBe(false);
  });
});
