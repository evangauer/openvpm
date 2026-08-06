"use client";

import {
  buildCloudSignupUrl,
  cloudSignupAppOrigin,
  FUNNEL_EVENTS,
  funnelToolFromPath,
  isDemoMode,
} from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";
import { usePathname } from "next/navigation";

/**
 * Persistent demo → Cloud signup bridge. Job language on purpose: we sell a
 * workflow they just tried, not a full PIMS rip-replace.
 */
export function DemoConversionBar() {
  const pathname = usePathname();
  if (!isDemoMode()) return null;

  const tool = funnelToolFromPath(pathname);
  const href = buildCloudSignupUrl({
    appOrigin: cloudSignupAppOrigin(),
    tool,
    source: "demo",
    medium: "product",
    campaign: `demo_${tool}`,
  });

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/20 bg-primary/5 px-3 py-2 sm:px-6">
      <p className="text-sm text-foreground">
        <span className="font-medium">Like this workflow?</span>{" "}
        <span className="text-muted-foreground">
          Start a free Cloud trial with your own clinic data.
        </span>
      </p>
      <a
        href={href}
        onClick={() =>
          trackFunnelEvent(FUNNEL_EVENTS.demoCtaStartClinic, {
            tool,
            path: pathname,
          })
        }
        className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Start my clinic
      </a>
    </div>
  );
}
