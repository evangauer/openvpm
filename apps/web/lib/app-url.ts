/**
 * App URL + auth-link exposure helpers, shared by flows that build auth links
 * (signup verification, password reset, staff invites).
 */

import { envFlagEnabled } from "@/lib/env-bool";

const LOCAL_APP_BASE_URL = "http://localhost:3000";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function appBaseUrl(): string {
  const raw = configuredAppBaseUrl();
  const normalized = normalizeAppBaseUrl(raw);
  if (normalized) {
    if (
      process.env.NODE_ENV === "production" &&
      !isProductionAppBaseUrl(normalized)
    ) {
      throw invalidAppBaseUrlError();
    }
    return normalized;
  }
  if (process.env.NODE_ENV === "production") {
    throw invalidAppBaseUrlError();
  }
  return LOCAL_APP_BASE_URL;
}

function configuredAppBaseUrl(): string {
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (publicUrl) return publicUrl;
  const authUrl = process.env.NEXTAUTH_URL?.trim();
  if (authUrl) return authUrl;
  return "";
}

export function normalizeAppBaseUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      !url.hostname
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function isProductionAppBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function invalidAppBaseUrlError(): Error {
  return new Error(
    "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to a valid HTTPS app origin."
  );
}

/**
 * Whether to return raw auth links (verify/reset/invite URLs) in API responses
 * so they're testable in local dev and explicitly opted-in preview builds.
 */
export function exposeAuthLinksForPreview(): boolean {
  return (
    envFlagEnabled("OPENVPM_EXPOSE_AUTH_LINKS") ||
    process.env.NODE_ENV !== "production"
  );
}
