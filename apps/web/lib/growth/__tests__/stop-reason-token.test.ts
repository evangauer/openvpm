import { describe, expect, it } from "vitest";
import {
  createStopReasonToken,
  STOP_REASON_TOKEN_TTL_SECONDS,
  verifyStopReasonToken,
} from "../stop-reason-token";

const secret = "a-test-secret-that-is-long-enough-to-sign";
const practiceId = "00000000-0000-4000-8000-0000000000aa";
const now = new Date("2026-11-05T12:00:00Z");

describe("stop reason token", () => {
  it("round-trips a practice id", () => {
    const token = createStopReasonToken(practiceId, { secret, now });
    expect(verifyStopReasonToken(token, { secret, now })).toEqual({
      practiceId,
    });
  });

  it("rejects tampering, other secrets, and expiry", () => {
    const token = createStopReasonToken(practiceId, { secret, now })!;
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        practiceId: "00000000-0000-4000-8000-0000000000bb",
        iat: 0,
        exp: 9_999_999_999,
      }),
    ).toString("base64url");

    expect(verifyStopReasonToken(`${forged}.${signature}`, { secret, now }))
      .toBeNull();
    expect(
      verifyStopReasonToken(`${payload}.${signature}x`, { secret, now }),
    ).toBeNull();
    expect(
      verifyStopReasonToken(token, { secret: `${secret}-other`, now }),
    ).toBeNull();
    expect(
      verifyStopReasonToken(token, {
        secret,
        now: new Date(now.getTime() + (STOP_REASON_TOKEN_TTL_SECONDS + 1) * 1000),
      }),
    ).toBeNull();
    expect(verifyStopReasonToken("", { secret, now })).toBeNull();
    expect(
      verifyStopReasonToken(token, { secret: "too-short", now }),
    ).toBeNull();
    expect(verifyStopReasonToken(`${token}.extra`, { secret, now })).toBeNull();
  });

  it("keeps links valid across a signing-secret rotation", () => {
    const token = createStopReasonToken(practiceId, { secret, now });
    expect(
      verifyStopReasonToken(token, {
        secret: "a-brand-new-secret-that-is-long-enough-to-sign",
        previousSecrets: secret,
        now,
      }),
    ).toEqual({ practiceId });
  });

  it("refuses to sign anything but a practice uuid", () => {
    expect(createStopReasonToken("not-a-uuid", { secret, now })).toBeNull();
  });
});
