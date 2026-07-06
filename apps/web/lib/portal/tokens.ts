import { createHash, randomBytes } from "node:crypto";

export const PORTAL_ACCESS_TOKEN_MAX_LENGTH = 64;

export function generatePortalAccessToken(): string {
  return randomBytes(32).toString("hex");
}

export function portalRateLimitKey(prefix: string, token: string): string {
  const digest = createHash("sha256").update(token).digest("hex");
  return `${prefix}:token:${digest}`;
}
