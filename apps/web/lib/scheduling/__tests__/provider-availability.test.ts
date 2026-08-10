import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  providerCoverageFromRows,
  type ProviderScheduleWindowRow,
} from "../provider-availability";

const LOCATION_A = "00000000-0000-0000-0000-000000000001";
const LOCATION_B = "00000000-0000-0000-0000-000000000002";
const DOCTOR_A = "00000000-0000-0000-0000-000000000003";
const DOCTOR_B = "00000000-0000-0000-0000-000000000004";

function row(
  overrides: Partial<ProviderScheduleWindowRow> = {},
): ProviderScheduleWindowRow {
  return {
    userId: DOCTOR_A,
    locationId: LOCATION_A,
    dayOfWeek: 1,
    startTime: "08:00:00",
    endTime: "17:00:00",
    ...overrides,
  };
}

describe("providerCoverageFromRows", () => {
  it("preserves the generic-hours fallback until any hours are configured", () => {
    expect(
      providerCoverageFromRows({
        rows: [],
        date: "2026-08-10",
        timezone: "America/Denver",
        locationId: LOCATION_A,
      }),
    ).toEqual({ configured: false, windows: [] });
  });

  it("fails closed for a configured provider on a closed day or other location", () => {
    const rows = [row()];
    expect(
      providerCoverageFromRows({
        rows,
        date: "2026-08-11",
        timezone: "America/Denver",
        locationId: LOCATION_A,
        doctorId: DOCTOR_A,
      }),
    ).toEqual({ configured: true, windows: [] });
    expect(
      providerCoverageFromRows({
        rows,
        date: "2026-08-10",
        timezone: "America/Denver",
        locationId: LOCATION_B,
        doctorId: DOCTOR_A,
      }),
    ).toEqual({ configured: true, windows: [] });
  });

  it("treats null-location legacy hours as practice-wide", () => {
    const coverage = providerCoverageFromRows({
      rows: [row({ locationId: null, startTime: "09:00", endTime: "12:30" })],
      date: "2026-08-10",
      timezone: "America/Denver",
      locationId: LOCATION_B,
    });
    expect(coverage.configured).toBe(true);
    expect(
      coverage.windows.map((window) => [
        window.start.toISOString(),
        window.end.toISOString(),
      ]),
    ).toEqual([["2026-08-10T15:00:00.000Z", "2026-08-10T18:30:00.000Z"]]);
  });

  it("merges pooled coverage across providers and honors DST", () => {
    const coverage = providerCoverageFromRows({
      rows: [
        row({ startTime: "08:00", endTime: "12:00" }),
        row({
          userId: DOCTOR_B,
          startTime: "11:00",
          endTime: "17:00",
        }),
      ],
      date: "2026-11-02",
      timezone: "America/Denver",
      locationId: LOCATION_A,
    });
    expect(coverage.windows).toHaveLength(1);
    expect(coverage.windows[0]!.start.toISOString()).toBe(
      "2026-11-02T15:00:00.000Z",
    );
    expect(coverage.windows[0]!.end.toISOString()).toBe(
      "2026-11-03T00:00:00.000Z",
    );
  });

  it("scopes configured fallback to the requested doctor", () => {
    expect(
      providerCoverageFromRows({
        rows: [row({ userId: DOCTOR_B })],
        date: "2026-08-10",
        timezone: "UTC",
        locationId: LOCATION_A,
        doctorId: DOCTOR_A,
      }),
    ).toEqual({ configured: false, windows: [] });
  });
});

describe("provider availability query safety", () => {
  const source = readFileSync(
    new URL("../provider-availability.ts", import.meta.url),
    "utf8",
  );

  it("scopes active schedule and provider rows to the same practice", () => {
    expect(source).toContain("eq(staffSchedules.practiceId, input.practiceId)");
    expect(source).toContain("eq(users.practiceId, input.practiceId)");
    expect(source).toContain("eq(users.isVeterinarian, true)");
    expect(source).toContain("isNull(users.deletedAt)");
    expect(source).toContain("isNull(staffSchedules.deletedAt)");
  });
});
