import { createHash, randomBytes } from "node:crypto";

/**
 * Capability tokens for in-consult QR photo capture. Same model as portal
 * links (lib/portal/tokens.ts) and the calendar feed (lib/calendar/tokens.ts):
 * the raw token IS the credential, so rate-limit keys hash it rather than
 * storing it in the buckets table. Capture tokens are short-lived (30 min).
 */

export const CAPTURE_TOKEN_LENGTH = 64;
export const CAPTURE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const CAPTURE_TOKEN_TTL_MS = 30 * 60 * 1000;
/** Consent links live longer than photo links: the form may wait in a lobby. */
export const CONSENT_TOKEN_TTL_MS = 60 * 60 * 1000;
export const CONSENT_RECEIPT_TOKEN_TTL_MS = 15 * 60 * 1000;

export function generateCaptureToken(): string {
  return randomBytes(32).toString("hex");
}

export function isCaptureTokenShape(value: string): boolean {
  return CAPTURE_TOKEN_PATTERN.test(value);
}

export function hashConsentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A separate, one-time-returned capability for the exact signed PDF copy. */
export function generateConsentReceiptToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashConsentReceiptToken(token: string): string {
  return createHash("sha256")
    .update("openvpm:consent-receipt:v1:")
    .update(token)
    .digest("hex");
}

/**
 * A treatment-plan holder already possesses a random, expiring bearer
 * credential. Derive its downstream signing capability deterministically so
 * retries can reconstruct the URL while the database stores only a digest.
 */
export function deriveTreatmentPlanConsentToken(
  treatmentPlanToken: string,
): string {
  return createHash("sha256")
    .update("openvpm:treatment-plan-consent:v1:")
    .update(treatmentPlanToken)
    .digest("hex");
}

export function captureRateLimitKey(prefix: string, token: string): string {
  const digest = hashConsentToken(token);
  return `${prefix}:token:${digest}`;
}
