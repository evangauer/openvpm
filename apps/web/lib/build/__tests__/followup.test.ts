import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFollowupConfig,
  buildFollowupDedupeKey,
  buildFollowupStepDue,
} from "@/lib/build/followup";

const NOW = new Date("2026-11-05T18:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

afterEach(() => vi.unstubAllEnvs());

describe("build follow-up schedule", () => {
  it("is off until enabled with a valid rollout time", () => {
    expect(buildFollowupConfig()).toEqual({ enabled: false, reason: "disabled" });
    vi.stubEnv("BUILD_FOLLOWUP_ENABLED", "true");
    vi.stubEnv("BUILD_FOLLOWUP_ROLLOUT_AT", "nope");
    expect(buildFollowupConfig()).toEqual({ enabled: false, reason: "rollout_at_invalid" });
    vi.stubEnv("BUILD_FOLLOWUP_ROLLOUT_AT", "2026-11-01T00:00:00Z");
    expect(buildFollowupConfig()).toMatchObject({ enabled: true });
  });

  it("sends a resume link 2 hours after the last save and one note at 3 days", () => {
    const due = (savedAgo: number, count = 0, lastAgo: number | null = null) =>
      buildFollowupStepDue({
        now: NOW,
        savedAt: ago(savedAgo),
        existingEmailCount: count,
        lastEmailAt: lastAgo === null ? null : ago(lastAgo),
      });
    expect(due(HOUR)).toBeNull();
    expect(due(2 * HOUR + 1)).toBe(1);
    expect(due(48 * HOUR, 1, 46 * HOUR)).toBeNull();
    expect(due(72 * HOUR + 1, 1, 70 * HOUR)).toBe(2);
    expect(due(80 * HOUR, 2, 8 * HOUR)).toBeNull();
    expect(due(15 * 24 * HOUR)).toBeNull();
  });

  it("keys each step per lead", () => {
    expect(buildFollowupDedupeKey("lead-1", 2)).toBe("lead:build-followup:v1:lead-1:2");
  });
});
