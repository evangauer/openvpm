"use client";

import { fetchWithClientTimeout } from "@/lib/client-fetch";

export function reportClientError(
  source: string,
  error: Error & { digest?: string }
): void {
  const endpoint = "/api/error-report";
  const payload = JSON.stringify({
    source,
    message: error.message || "Unknown error",
    stack: error.stack ?? null,
    digest: error.digest ?? null,
    path: typeof window !== "undefined" ? window.location.pathname : null,
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
