import { describe, expect, it } from "vitest";
import { engagementFor, type PracticeTracking } from "../practice-tracking-types";

const now = new Date("2026-11-08T17:00:00Z");
const base = {
  lastActionAt: "2026-11-08T10:00:00Z", activeDays7: 1,
  usage: { clients: 0, patients: 0, appointments: 1 },
} as PracticeTracking;
describe("product engagement evidence", () => {
  it("does not equate a trial, AI or a sample appointment with own-record adoption", () => {
    expect(engagementFor(base, now)).toBe("Exploring sample data");
    expect(engagementFor({ ...base, lastActionAt: null }, now)).toBe("No recorded product actions");
  });
  it("requires own records for returning use, and ages out old actions", () => {
    const own = { ...base, usage: { ...base.usage, clients: 1 } };
    expect(engagementFor(own, now)).toBe("Own records added");
    expect(engagementFor({ ...own, activeDays7: 2 }, now)).toBe("Returning use with own records");
    expect(engagementFor({ ...own, lastActionAt: "2026-10-01T00:00:00Z" }, now)).toBe("No recorded actions in 7 days");
  });
});
