import { describe, expect, it } from "vitest";
import { createNpsToken, verifyNpsToken } from "@/lib/growth/nps-token";
import { createStopReasonToken } from "@/lib/growth/stop-reason-token";

const SECRET = "s".repeat(48);
const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-11-05T16:00:00Z");

describe("NPS tokens", () => {
  it("round-trips the practice and survey", () => {
    const token = createNpsToken(PRACTICE_ID, "nps:2", { secret: SECRET, now: NOW });
    expect(verifyNpsToken(token, { secret: SECRET, now: NOW })).toEqual({
      practiceId: PRACTICE_ID,
      survey: "nps:2",
    });
  });

  it("never accepts a stop-reason token, or the reverse", () => {
    const stop = createStopReasonToken(PRACTICE_ID, { secret: SECRET, now: NOW });
    expect(verifyNpsToken(stop, { secret: SECRET, now: NOW })).toBeNull();
  });

  it("rejects tampering, expiry, and invalid survey keys", () => {
    const token = createNpsToken(PRACTICE_ID, "nps:1", { secret: SECRET, now: NOW })!;
    expect(verifyNpsToken(`${token}x`, { secret: SECRET, now: NOW })).toBeNull();
    expect(
      verifyNpsToken(token, {
        secret: SECRET,
        now: new Date(NOW.getTime() + 46 * 24 * 60 * 60 * 1000),
      }),
    ).toBeNull();
    expect(createNpsToken(PRACTICE_ID, "NPS 1!", { secret: SECRET })).toBeNull();
  });
});
