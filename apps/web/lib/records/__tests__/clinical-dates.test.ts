import { describe, expect, it } from "vitest";
import {
  clinicalDateKey,
  formatClinicalDate,
  formatClinicalDateTime,
} from "../clinical-dates";

describe("clinical date helpers", () => {
  it("formats instants in the practice timezone without shifting date-only values", () => {
    expect(
      formatClinicalDate(
        "2026-07-01T04:30:00.000Z",
        "America/Los_Angeles"
      )
    ).toBe("Jun 30, 2026");
    expect(formatClinicalDate("2026-07-01", "America/Los_Angeles")).toBe(
      "Jul 1, 2026"
    );
  });

  it("formats clinical date-times in the practice timezone", () => {
    const label = formatClinicalDateTime(
      "2026-07-01T04:30:00.000Z",
      "America/Los_Angeles"
    );

    expect(label).toContain("Jun 30, 2026");
    expect(label).toContain("9:30 PM");
  });

  it("builds practice-local date keys and preserves date-only keys", () => {
    expect(
      clinicalDateKey(
        "2026-07-01T04:30:00.000Z",
        "America/Los_Angeles"
      )
    ).toBe("2026-06-30");
    expect(clinicalDateKey("2026-07-01", "America/Los_Angeles")).toBe(
      "2026-07-01"
    );
    expect(formatClinicalDate("not-a-date", "America/Los_Angeles")).toBe("--");
  });
});
