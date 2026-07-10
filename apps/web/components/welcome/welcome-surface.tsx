"use client";

import { PawPrint, X } from "lucide-react";
import type { GuideContext } from "@/components/tour/guide-recipes";
import type { WelcomeCardId } from "@/lib/welcome/cards";
import { WELCOME_COPY } from "./welcome-copy";
import { PolaroidCard, type WelcomeVariant } from "./polaroid-card";
import { AiVignette } from "./vignettes/ai-vignette";
import {
  CalendarVignette,
  DayVignette,
  PortalVignette,
} from "./vignettes/static-vignettes";

const TILTS = [-3, 2, -2, 3];

const VIGNETTES: Record<WelcomeCardId, React.ComponentType> = {
  "ask-ai": AiVignette,
  "your-day": DayVignette,
  "client-portal": PortalVignette,
  "calendar-feed": CalendarVignette,
};

/**
 * The value-first welcome: a pastel table with a few Polaroids scattered
 * on it, each one a "first win" walkthrough on live (demo) data. Shown
 * before any setup is asked of the user; the wizard is one click away for
 * admins who would rather set up first.
 */
export function WelcomeSurface({
  headline,
  cards,
  completed,
  variant,
  guideContext,
  showSetupLink,
  onStartGuide,
  onSkip,
  onSetupInstead,
}: {
  headline: string;
  cards: WelcomeCardId[];
  completed: Set<string>;
  variant: WelcomeVariant;
  guideContext: GuideContext;
  showSetupLink: boolean;
  onStartGuide: (card: WelcomeCardId, ctx: GuideContext) => void;
  onSkip: () => void;
  onSetupInstead: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to OpenVPM"
      className="fixed inset-0 z-[80] overflow-y-auto"
      style={{
        background:
          "linear-gradient(135deg, #fff7ed 0%, #f5f3ff 30%, #fdf2f8 60%, #ecfdf5 100%)",
      }}
    >
      <button
        type="button"
        onClick={onSkip}
        aria-label="Skip the welcome"
        className="absolute right-4 top-4 rounded-full p-2 text-slate-500 transition-colors hover:bg-white/70 hover:text-slate-800"
      >
        <X className="h-5 w-5" />
      </button>

      <div className="mx-auto flex min-h-full max-w-5xl flex-col items-center justify-center px-6 pb-32 pt-14 text-center">
        <div className="flex items-center gap-2 text-emerald-700">
          <PawPrint className="h-5 w-5" aria-hidden="true" />
          <span className="text-sm font-semibold uppercase tracking-wide">
            OpenVPM
          </span>
        </div>
        <h1 className="mt-3 font-heading text-3xl font-bold text-slate-900 sm:text-4xl">
          {headline}
        </h1>
        <p className="mt-3 max-w-xl text-base leading-7 text-slate-600">
          {WELCOME_COPY.subline}
        </p>

        <div className="mt-10 flex flex-wrap items-start justify-center gap-6">
          {cards.map((card, i) => {
            const Vignette = VIGNETTES[card];
            return (
              <PolaroidCard
                key={card}
                card={card}
                tilt={TILTS[i % TILTS.length]!}
                done={completed.has(card)}
                variant={variant}
                enterDelayMs={i * 420}
                onOpen={() => onStartGuide(card, guideContext)}
              >
                <Vignette />
              </PolaroidCard>
            );
          })}
        </div>

        <style>{`
          /* Polaroids drop and settle one after another; the rows inside
             each picture then place themselves in order. backwards-fill
             only, so hover/tilt transforms take over once settled. */
          @keyframes welcome-card-in {
            0% { opacity: 0; transform: translateY(-14px) rotate(var(--tilt)) scale(0.96); }
            70% { opacity: 1; transform: translateY(2px) rotate(var(--tilt)) scale(1.005); }
            100% { opacity: 1; transform: translateY(0) rotate(var(--tilt)) scale(1); }
          }
          .welcome-card-enter {
            animation: welcome-card-in 560ms ease-out backwards;
            animation-delay: var(--enter-delay, 0ms);
          }
          @keyframes welcome-row-in {
            0% { opacity: 0; transform: translateY(4px); }
            100% { opacity: 1; transform: translateY(0); }
          }
          .vignette-stagger > * {
            animation: welcome-row-in 480ms ease-out backwards;
            animation-delay: calc(var(--enter-delay, 0ms) + 260ms);
          }
          .vignette-stagger > *:nth-child(2) { animation-delay: calc(var(--enter-delay, 0ms) + 420ms); }
          .vignette-stagger > *:nth-child(3) { animation-delay: calc(var(--enter-delay, 0ms) + 580ms); }
          .vignette-stagger > *:nth-child(4) { animation-delay: calc(var(--enter-delay, 0ms) + 740ms); }
          @media (prefers-reduced-motion: reduce) {
            .welcome-card-enter, .vignette-stagger > * { animation: none; }
          }
        `}</style>

        <div className="mt-10 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="text-sm font-medium text-slate-600 underline-offset-4 hover:underline"
          >
            {WELCOME_COPY.skip}
          </button>
          <p className="text-xs text-slate-500">{WELCOME_COPY.reopenHint}</p>
          {showSetupLink ? (
            <button
              type="button"
              onClick={onSetupInstead}
              className="mt-2 text-sm font-semibold text-primary underline-offset-4 hover:underline"
            >
              {WELCOME_COPY.setupInstead}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
