import { createHash, randomBytes } from "node:crypto";

/**
 * Capability tokens for the read-only ICS schedule feed. Same model as
 * portal links (lib/portal/tokens.ts): the raw token IS the credential, so
 * rate-limit keys hash it rather than storing it in the buckets table.
 */

export const CALENDAR_FEED_TOKEN_LENGTH = 64;
export const CALENDAR_FEED_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function generateCalendarFeedToken(): string {
  return randomBytes(32).toString("hex");
}

export function isCalendarFeedTokenShape(value: string): boolean {
  return CALENDAR_FEED_TOKEN_PATTERN.test(value);
}

export function calendarRateLimitKey(prefix: string, token: string): string {
  const digest = createHash("sha256").update(token).digest("hex");
  return `${prefix}:token:${digest}`;
}
