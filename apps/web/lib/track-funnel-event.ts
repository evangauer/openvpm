"use client";

import { track } from "@vercel/analytics";
import type { FunnelEventName } from "@/lib/funnel-analytics";

type FunnelProps = Record<string, string | number | boolean | null | undefined>;

/**
 * Fire a named funnel event to Vercel Web Analytics. Never include PHI —
 * only tool ids, roles, and coarse path labels.
 */
export function trackFunnelEvent(
  name: FunnelEventName,
  props?: FunnelProps
): void {
  try {
    const cleaned: Record<string, string | number | boolean> = {};
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue;
        cleaned[key] = value;
      }
    }
    track(name, cleaned);
  } catch {
    // Analytics must never break demo/signup UX.
  }
}
