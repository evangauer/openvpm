import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  AUTH_SECRET_SETUP_COMMAND,
  MIN_AUTH_SECRET_LENGTH,
  authSecretProblem,
  authSecretStrengthEnforced,
  nextAuthSecret,
  type AuthSecretProblem,
} from "@/lib/auth-secret";

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

/**
 * Why a configured PORTAL_SESSION_SECRET is being ignored in production, or
 * null when it is unset, acceptable, or strength isn't enforced.
 */
export function portalSessionSecretProblem(): AuthSecretProblem | null {
  const portalSecret = process.env.PORTAL_SESSION_SECRET?.trim();
  if (!portalSecret || !authSecretStrengthEnforced()) return null;
  return authSecretProblem(portalSecret);
}

let warnedAboutPortalSecret = false;

function portalMetadataSecret(): string {
  // nextAuthSecret() already withholds a published or short secret in
  // production. A weak dedicated portal secret is skipped in favor of it
  // rather than taking the portal down: it only keys request metadata hashes.
  const portalSecret = process.env.PORTAL_SESSION_SECRET?.trim();
  const portalProblem = portalSessionSecretProblem();
  if (portalProblem && !warnedAboutPortalSecret) {
    warnedAboutPortalSecret = true;
    console.warn(
      `[openvpm] PORTAL_SESSION_SECRET is ${
        portalProblem === "too_short"
          ? `shorter than ${MIN_AUTH_SECRET_LENGTH} characters`
          : "a published placeholder value"
      }; using NEXTAUTH_SECRET for portal metadata instead. Replace it (${AUTH_SECRET_SETUP_COMMAND}) or remove it.`,
    );
  }
  const configured =
    portalSecret && !portalProblem ? portalSecret : nextAuthSecret();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "A strong PORTAL_SESSION_SECRET or NEXTAUTH_SECRET is required in production",
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
