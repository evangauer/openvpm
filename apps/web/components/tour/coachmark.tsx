"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TourStep } from "./tour-steps";

const CARD_W = 320;

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

  let cardStyle: React.CSSProperties | undefined;
  if (rect && typeof window !== "undefined") {
    const spaceRight = window.innerWidth - rect.right;
    const left =
      spaceRight > CARD_W + 32
        ? rect.right + 16
        : Math.max(16, rect.left - CARD_W - 16);
    const top = Math.min(Math.max(rect.top, 16), window.innerHeight - 260);
    cardStyle = { left, top };
  }

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
          "fixed z-[70] w-80 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl",
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
