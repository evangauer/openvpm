"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TourStep } from "./tour-steps";

const CARD_W = 320;
const CARD_H = 260; // placement estimate, matches the viewport clamp below
const GAP = 16;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

/**
 * Do-it steps open floating UI right next to their anchor (the calendar
 * popover, for one), and the card at z-70 would sit on top of the thing it
 * just asked the user to open. Watch the body for Radix popper portals and
 * hand back a position clear of both the popper and the anchor.
 */
function useDodgeFloatingUi(
  base: { left: number; top: number } | null,
  anchor: DOMRect | null
): { left: number; top: number } | null {
  const [dodged, setDodged] = useState<{ left: number; top: number } | null>(
    null
  );

  useEffect(() => {
    if (!base || !anchor || typeof document === "undefined") {
      setDodged(null);
      return;
    }
    const compute = () => {
      const poppers = Array.from(
        document.querySelectorAll("[data-radix-popper-content-wrapper]")
      ).map((el) => el.getBoundingClientRect());
      const card: Box = {
        left: base.left,
        top: base.top,
        right: base.left + CARD_W,
        bottom: base.top + CARD_H,
      };
      const hit = poppers.find((p) => p.width > 0 && overlaps(card, p));
      if (!hit) {
        setDodged(null);
        return;
      }
      // Try fully left of the popper + anchor; otherwise drop below them.
      const unionLeft = Math.min(hit.left, anchor.left);
      const leftOf = unionLeft - CARD_W - GAP;
      if (leftOf >= GAP) {
        setDodged({ left: leftOf, top: base.top });
        return;
      }
      const unionBottom = Math.max(hit.bottom, anchor.bottom);
      setDodged({
        left: Math.max(GAP, Math.min(base.left, window.innerWidth - CARD_W - GAP)),
        top: Math.min(unionBottom + GAP, window.innerHeight - CARD_H - GAP),
      });
    };
    // Radix mounts the portal first and positions it a frame later via a
    // style transform (no childList mutation), so measure again shortly
    // after any mutation or the popper is still at 0x0 when we look.
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const computeSoon = () => {
      if (!active) return;
      compute();
      timers.push(setTimeout(() => active && compute(), 120));
      timers.push(setTimeout(() => active && compute(), 400));
    };
    computeSoon();
    const mo = new MutationObserver(computeSoon);
    mo.observe(document.body, { childList: true });
    return () => {
      active = false;
      timers.forEach(clearTimeout);
      mo.disconnect();
    };
  }, [base?.left, base?.top, anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  return dodged;
}

interface CoachmarkProps {
  /** Anchor rect to spotlight, or null for a centered card. */
  rect: DOMRect | null;
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

export function Coachmark({
  rect,
  step,
  index,
  total,
  onNext,
  onBack,
  onSkip,
}: CoachmarkProps) {
  const isCentered = !rect;
  const isLast = index === total - 1;

  let basePosition: { left: number; top: number } | null = null;
  if (rect && typeof window !== "undefined") {
    const spaceRight = window.innerWidth - rect.right;
    const left =
      spaceRight > CARD_W + 32
        ? rect.right + GAP
        : Math.max(GAP, rect.left - CARD_W - GAP);
    const top = Math.min(Math.max(rect.top, GAP), window.innerHeight - CARD_H);
    basePosition = { left, top };
  }
  const dodged = useDodgeFloatingUi(basePosition, rect);
  const cardStyle: React.CSSProperties | undefined =
    dodged ?? basePosition ?? undefined;

  return (
    <>
      {isCentered ? (
        <div className="fixed inset-0 z-[60] bg-slate-900/50" />
      ) : (
        <div
          className="pointer-events-none fixed z-[60] rounded-lg ring-2 ring-primary transition-all duration-200"
          style={{
            left: rect!.left - 6,
            top: rect!.top - 6,
            width: rect!.width + 12,
            height: rect!.height + 12,
            boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.45)",
          }}
        />
      )}

      <div
        role="dialog"
        aria-label={step.title}
        className={cn(
          "fixed z-[70] w-80 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl transition-[left,top] duration-200",
          isCentered && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        )}
        style={cardStyle}
      >
        <button
          type="button"
          onClick={onSkip}
          aria-label="Skip tour"
          className="absolute right-3 top-3 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>

        <h3 className="pr-6 font-heading text-base font-semibold">{step.title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          {step.body}
        </p>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {Array.from({ length: total }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === index ? "w-4 bg-primary" : "w-1.5 bg-border"
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {index > 0 ? (
              <Button variant="ghost" size="sm" onClick={onBack}>
                Back
              </Button>
            ) : null}
            {/* On do-it steps (advanceOn) the page owns the primary action,
                so the button reads as the way past, not the way forward. */}
            <Button
              size="sm"
              variant={!isLast && step.advanceOn ? "ghost" : "default"}
              onClick={onNext}
            >
              {isLast ? "Finish" : step.advanceOn ? "Skip this step" : "Next"}
            </Button>
          </div>
        </div>

        {!isLast ? (
          <button
            type="button"
            onClick={onSkip}
            className="mt-2 text-xs text-muted-foreground hover:underline"
          >
            Skip tour
          </button>
        ) : null}
      </div>
    </>
  );
}
