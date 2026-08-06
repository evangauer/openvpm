"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  FUNNEL_EVENTS,
  funnelToolFromPath,
  isDemoMode,
} from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";

/**
 * On the demo deployment, emit demo_tool_opened once per distinct tool path
 * per page session so we can see which jobs people try before signup.
 */
export function DemoFunnelTracker() {
  const pathname = usePathname();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!isDemoMode()) return;
    const tool = funnelToolFromPath(pathname);
    if (seen.current.has(tool)) return;
    seen.current.add(tool);
    trackFunnelEvent(FUNNEL_EVENTS.demoToolOpened, { tool, path: pathname });
  }, [pathname]);

  return null;
}
