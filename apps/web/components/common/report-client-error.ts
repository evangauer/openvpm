"use client";

import { fetchWithClientTimeout } from "@/lib/client-fetch";
import {
  classifyClientError,
  sanitizeClientErrorDigest,
  sanitizeClientErrorPath,
  type ClientErrorSource,
} from "@/lib/client-error-report";
import { getFunnelVisitorId } from "@/lib/funnel-visitor";

export function reportClientError(
  source: ClientErrorSource,
  error: Error & { digest?: string }
): void {
  const endpoint = "/api/error-report";
  const payload = JSON.stringify({
    source,
    errorFamily: classifyClientError(error),
    digest: sanitizeClientErrorDigest(error.digest),
    path:
      typeof window !== "undefined"
        ? sanitizeClientErrorPath(window.location.pathname)
        : null,
    anonymousId: getFunnelVisitorId(),
  });

  if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(endpoint, blob)) {
        return;
      }
    } catch {
      // Fall through to fetch. Error reporting should never crash recovery UI.
    }
  }

  if (typeof fetch === "undefined") return;

  void fetchWithClientTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}
