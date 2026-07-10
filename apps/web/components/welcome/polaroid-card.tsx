"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WelcomeCardId } from "@/lib/welcome/cards";
import { WELCOME_CARD_COPY } from "./welcome-copy";
import { ImageryBackdrop } from "./vignettes/imagery";

export type WelcomeVariant = "vignette" | "imagery";

/**
 * A guide card dressed as a Polaroid: white frame, picture window, a
 * handwritten-feeling caption, and a slight tilt that straightens when you
 * reach for it. The picture is a faux-UI vignette; the "imagery" variant
 * layers it as a chip over a warm scenic backdrop instead.
 */
export function PolaroidCard({
  card,
  tilt,
  done,
  variant,
  enterDelayMs = 0,
  onOpen,
  children,
}: {
  card: WelcomeCardId;
  /** Degrees of resting rotation; alternates per card for the scattered look. */
  tilt: number;
  done: boolean;
  variant: WelcomeVariant;
  /** Staggers the drop-and-settle entrance so cards arrive in order. */
  enterDelayMs?: number;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const copy = WELCOME_CARD_COPY[card];
  return (
    <button
      type="button"
      onClick={onOpen}
      style={
        {
          "--tilt": `${tilt}deg`,
          "--enter-delay": `${enterDelayMs}ms`,
        } as React.CSSProperties
      }
      className={cn(
        "group w-56 shrink-0 rounded-sm bg-white p-3 pb-4 text-left shadow-md ring-1 ring-black/5",
        "welcome-card-enter rotate-[var(--tilt)] transition-all duration-300 ease-out",
        "hover:z-10 hover:rotate-0 hover:-translate-y-2 hover:shadow-xl",
        "focus-visible:z-10 focus-visible:rotate-0 focus-visible:-translate-y-2 focus-visible:shadow-xl",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      )}
    >
      <span className="relative block aspect-[4/3] overflow-hidden rounded-[2px] bg-muted">
        {variant === "imagery" ? (
          <>
            <ImageryBackdrop card={card} />
            {/* The vignette lays out at the full picture-window size, then
                scales down into a floating chip so nothing re-wraps or clips. */}
            <span className="absolute bottom-1.5 right-1.5 block aspect-[4/3] w-3/4 overflow-hidden rounded-md shadow-lg ring-1 ring-black/5">
              <span className="absolute left-0 top-0 block h-[133.34%] w-[133.34%] origin-top-left scale-75">
                {children}
              </span>
            </span>
          </>
        ) : (
          children
        )}
        {done ? (
          <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-primary shadow-sm">
            <Check className="h-3 w-3" aria-hidden="true" />
            Done
          </span>
        ) : null}
      </span>
      <span className="mt-2.5 block font-heading text-sm font-semibold leading-snug text-slate-900">
        {copy.caption}
      </span>
      <span className="mt-0.5 block text-xs leading-5 text-slate-500">
        {copy.sub}
      </span>
      <span className="mt-2 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
        {copy.chip}
      </span>
    </button>
  );
}
