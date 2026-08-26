import { createHash, createHmac, randomBytes } from "node:crypto";

export const PORTAL_ACCESS_TOKEN_MAX_LENGTH = 64;
export const PORTAL_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const PORTAL_SESSION_TOKEN_MAX_LENGTH = 64;
export const PORTAL_SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PORTAL_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const PORTAL_SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function generatePortalAccessToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashPortalAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generatePortalSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashPortalSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function portalMetadataSecret(): string {
  const configured =
    process.env.PORTAL_SESSION_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PORTAL_SESSION_SECRET or NEXTAUTH_SECRET is required in production",
    );
  }
  return "openvpm-local-portal-metadata-secret";
}

/** HMAC request metadata so raw IP addresses and user agents are not stored. */
export function hashPortalRequestMetadata(value: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return createHmac("sha256", portalMetadataSecret())
    .update(normalized)
    .digest("hex");
}

export function portalRateLimitKey(prefix: string, token: string): string {
  const digest = hashPortalAccessToken(token);
  return `${prefix}:token:${digest}`;
}
