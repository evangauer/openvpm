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

export function generateCaptureToken(): string {
  return randomBytes(32).toString("hex");
}

export function isCaptureTokenShape(value: string): boolean {
  return CAPTURE_TOKEN_PATTERN.test(value);
}

export function captureRateLimitKey(prefix: string, token: string): string {
  const digest = createHash("sha256").update(token).digest("hex");
  return `${prefix}:token:${digest}`;
}
