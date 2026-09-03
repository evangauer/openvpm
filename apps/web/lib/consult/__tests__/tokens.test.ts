import { describe, expect, it } from "vitest";
import {
  CAPTURE_TOKEN_LENGTH,
  CAPTURE_TOKEN_TTL_MS,
  CONSENT_RECEIPT_TOKEN_TTL_MS,
  CONSENT_TOKEN_TTL_MS,
  captureRateLimitKey,
  deriveTreatmentPlanConsentToken,
  generateCaptureToken,
  generateConsentReceiptToken,
  hashConsentReceiptToken,
  hashConsentToken,
  isCaptureTokenShape,
} from "../tokens";

describe("capture tokens", () => {
  it("generates 64-hex tokens that pass the shape guard", () => {
    const token = generateCaptureToken();
    expect(token).toHaveLength(CAPTURE_TOKEN_LENGTH);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(isCaptureTokenShape(token)).toBe(true);
  });

  it("derives a stable, domain-separated downstream consent capability", () => {
    const treatmentPlanToken = "ab".repeat(32);
    const derived = deriveTreatmentPlanConsentToken(treatmentPlanToken);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toBe(treatmentPlanToken);
    expect(deriveTreatmentPlanConsentToken(treatmentPlanToken)).toBe(derived);
    expect(hashConsentToken(derived)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(
      Array.from({ length: 32 }, () => generateCaptureToken()),
    );
    expect(tokens.size).toBe(32);
  });

  it("rejects malformed token shapes", () => {
    const valid = "ab".repeat(32);
    for (const bad of [
      "",
      "short",
      "Z".repeat(64),
      "AB".repeat(32), // uppercase hex is not what we mint
      `${valid}x`,
      valid.slice(0, 63),
      "../../../etc/passwd",
    ]) {
      expect(isCaptureTokenShape(bad)).toBe(false);
    }
    expect(isCaptureTokenShape(valid)).toBe(true);
  });

  it("expires capture links after 30 minutes", () => {
    expect(CAPTURE_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
  });

  it("expires consent links after 60 minutes", () => {
    expect(CONSENT_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("mints receipt credentials separately and stores only a domain-separated digest", () => {
    const token = generateConsentReceiptToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(CONSENT_RECEIPT_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    const digest = hashConsentReceiptToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(token);
    expect(digest).not.toBe(hashConsentToken(token));
    expect(hashConsentReceiptToken(token)).toBe(digest);
  });

  it("hashes the token in rate-limit keys (never the raw credential)", () => {
    const token = generateCaptureToken();
    const key = captureRateLimitKey("capture-upload", token);
    expect(key.startsWith("capture-upload:token:")).toBe(true);
    expect(key).not.toContain(token);
    expect(key).toMatch(/^capture-upload:token:[0-9a-f]{64}$/);
    // Deterministic per token, distinct across tokens.
    expect(captureRateLimitKey("capture-upload", token)).toBe(key);
    expect(
      captureRateLimitKey("capture-upload", generateCaptureToken()),
    ).not.toBe(key);
  });
});
