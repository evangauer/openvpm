import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_VERSION,
  sessionVersionIsCurrent,
} from "../session-version";

describe("sessionVersionIsCurrent", () => {
  it("accepts a session issued for the current version", () => {
    expect(sessionVersionIsCurrent(3, 3)).toBe(true);
  });

  it("rejects a session issued before the version was bumped", () => {
    expect(sessionVersionIsCurrent(1, 2)).toBe(false);
  });

  it("treats sessions issued before versioning as the column default", () => {
    expect(DEFAULT_SESSION_VERSION).toBe(1);
    expect(sessionVersionIsCurrent(undefined, 1)).toBe(true);
    expect(sessionVersionIsCurrent(null, 1)).toBe(true);
    expect(sessionVersionIsCurrent(undefined, 2)).toBe(false);
  });

  it("rejects malformed versions", () => {
    expect(sessionVersionIsCurrent("1", 1)).toBe(false);
    expect(sessionVersionIsCurrent(1.5, 1.5)).toBe(false);
    expect(sessionVersionIsCurrent(Number.NaN, Number.NaN)).toBe(false);
  });
});
