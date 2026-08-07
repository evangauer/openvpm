"use client";

import { track } from "@vercel/analytics";
import type { FunnelEventName } from "@/lib/funnel-analytics";
import { getFunnelVisitorId } from "@/lib/funnel-visitor";

type FunnelProps = Record<string, string | number | boolean | null | undefined>;

/**
 * Fire a named funnel event to Vercel Web Analytics. Never include PHI —
 * only tool ids, roles, and coarse path labels.
 */
export function trackFunnelEvent(
  name: FunnelEventName,
  props?: FunnelProps
): void {
  const cleaned: Record<string, string | number | boolean> = {};
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      cleaned[key] = value;
    }
  }

  try {
    track(name, cleaned);
  } catch {
    // Analytics must never break demo/signup UX.
  }

  try {
    const anonymousId = getFunnelVisitorId();
    const eventId = globalThis.crypto?.randomUUID?.();
    if (!anonymousId || !eventId || typeof window === "undefined") return;

    const hostedFunnelOrigin =
      window.location.hostname === "demo.openvpm.com"
        ? "https://app.openvpm.com"
        : window.location.origin;
    const configuredOrigin =
      process.env.NEXT_PUBLIC_FUNNEL_ENDPOINT?.trim() || hostedFunnelOrigin;
    const endpoint = new URL("/api/funnel-event", configuredOrigin).toString();
    const path =
      typeof cleaned.path === "string"
        ? cleaned.path
        : `${window.location.pathname}${window.location.search}`;
    const source =
      typeof cleaned.source === "string" ? cleaned.source : undefined;

    void fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      keepalive: true,
      body: JSON.stringify({
        eventId,
        anonymousId,
        name,
        source,
        path,
        props: cleaned,
      }),
    }).catch(() => undefined);
  } catch {
    // First-party funnel recording must never break the product journey.
  }
}
