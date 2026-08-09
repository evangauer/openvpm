import { describe, expect, it } from "vitest";
import {
  dateInputDayUtcRange,
  dateInputTimeUtcInstant,
  dateInputUtcRangeForTimeZone,
  dateTimeLocalInputUtcInstant,
  formatDateInputForTimeZone,
  formatDateTimeLocalInputForTimeZone,
  formatDateInputLocal,
} from "../date-input";

describe("date input helpers", () => {
  it("formats YYYY-MM-DD values from local calendar components", () => {
    expect(formatDateInputLocal(new Date(2026, 5, 1, 23, 30))).toBe(
      "2026-06-01"
    );
  });

  it("pads single-digit months and days", () => {
    expect(formatDateInputLocal(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });

  it("formats YYYY-MM-DD values for an explicit practice timezone", () => {
    const now = new Date("2026-07-15T02:30:00.000Z");

    expect(formatDateInputForTimeZone(now, "America/Los_Angeles")).toBe(
      "2026-07-14"
    );
    expect(formatDateInputForTimeZone(now, "Asia/Tokyo")).toBe("2026-07-15");
  });

  it("normalizes padded practice timezone values before formatting", () => {
    const now = new Date("2026-07-15T02:30:00.000Z");

    expect(formatDateInputForTimeZone(now, " America/Los_Angeles ")).toBe(
      "2026-07-14"
    );
  });

  it("treats blank timezone values as local fallbacks", () => {
    const now = new Date(2026, 6, 15, 2, 30);

    expect(formatDateInputForTimeZone(now, "   ")).toBe(
      formatDateInputLocal(now)
    );
  });

  it("builds UTC bounds for an explicit practice timezone day", () => {
    const range = dateInputUtcRangeForTimeZone(
      new Date("2026-07-15T02:30:00.000Z"),
      "America/Los_Angeles"
    );

    expect(range.date).toBe("2026-07-14");
    expect(range.start.toISOString()).toBe("2026-07-14T07:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("builds UTC bounds across daylight saving changes", () => {
    const range = dateInputUtcRangeForTimeZone(
      new Date("2026-03-08T12:00:00.000Z"),
      "America/Los_Angeles"
    );

    expect(range.date).toBe("2026-03-08");
    expect(range.start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("builds UTC bounds for an explicit date input in a timezone", () => {
    const range = dateInputDayUtcRange(
      "2026-07-14",
      "America/Los_Angeles"
    );

    expect(range.date).toBe("2026-07-14");
    expect(range.start.toISOString()).toBe("2026-07-14T07:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("builds UTC bounds with padded timezone values", () => {
    const range = dateInputDayUtcRange(
      "2026-07-14",
      " America/Los_Angeles "
    );

    expect(range.start.toISOString()).toBe("2026-07-14T07:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("builds a UTC instant for an explicit date input and local hour", () => {
    const instant = dateInputTimeUtcInstant(
      "2026-07-14",
      { hour: 8 },
      "America/Los_Angeles"
    );

    expect(instant.toISOString()).toBe("2026-07-14T15:00:00.000Z");
  });

  it("builds local-hour instants with padded timezone values", () => {
    const instant = dateInputTimeUtcInstant(
      "2026-07-14",
      { hour: 8 },
      " America/Los_Angeles "
    );

    expect(instant.toISOString()).toBe("2026-07-14T15:00:00.000Z");
  });

  it("builds local-hour instants across daylight saving changes", () => {
    const instant = dateInputTimeUtcInstant(
      "2026-03-08",
      { hour: 18 },
      "America/Los_Angeles"
    );

    expect(instant.toISOString()).toBe("2026-03-09T01:00:00.000Z");
  });

  it("supports hour 24 as next local midnight", () => {
    const instant = dateInputTimeUtcInstant(
      "2026-07-14",
      { hour: 24 },
      "America/Los_Angeles"
    );

    expect(instant.toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("parses datetime-local values in the clinic timezone, not browser timezone", () => {
    const originalTimeZone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const fromUtcBrowser = dateTimeLocalInputUtcInstant(
        "2026-08-10T12:30",
        "America/Denver",
      );
      process.env.TZ = "America/New_York";
      const fromEasternBrowser = dateTimeLocalInputUtcInstant(
        "2026-08-10T12:30",
        "America/Denver",
      );

      expect(fromUtcBrowser?.toISOString()).toBe("2026-08-10T18:30:00.000Z");
      expect(fromEasternBrowser?.toISOString()).toBe(fromUtcBrowser?.toISOString());
    } finally {
      process.env.TZ = originalTimeZone;
    }
  });

  it("rejects a clinic-local time skipped by daylight saving", () => {
    expect(
      dateTimeLocalInputUtcInstant(
        "2026-03-08T02:30",
        "America/Denver",
      ),
    ).toBeNull();
  });

  it("formats an existing due instant for datetime-local reassignment", () => {
    expect(
      formatDateTimeLocalInputForTimeZone(
        "2026-08-10T18:30:00.000Z",
        "America/Denver",
      ),
    ).toBe("2026-08-10T12:30");
  });
});
