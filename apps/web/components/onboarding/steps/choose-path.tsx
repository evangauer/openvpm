"use client";

import { useEffect } from "react";
import { Check, Compass, RefreshCcw, Rocket, Server } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  getOnboardingIntentOption,
  ONBOARDING_INTENT_OPTIONS,
  type OnboardingIntent,
} from "@/lib/onboarding/intent";
import type { StepProps } from "../journey-types";

const intentIcons = {
  alongside: RefreshCcw,
  replace: Rocket,
  explore: Compass,
  self_host: Server,
} satisfies Record<OnboardingIntent, typeof Compass>;

/**
 * The first setup question is intentionally about the customer's job, not
 * product configuration. The answer is stored with onboarding progress so the
 * checklist and platform funnel can keep the same pathway context.
 */
export function ChoosePathStep({ register, state, setState }: StepProps) {
  const utils = trpc.useUtils();
  const saveIntent = trpc.settings.setOnboardingIntent.useMutation();
  const selected = getOnboardingIntentOption(state.onboardingIntent);

  useEffect(() => {
    register({
      async onContinue() {
        await saveIntent.mutateAsync({ intent: state.onboardingIntent });
        // The journey provider derives its same-session resume point from this
        // cache. Keep it aligned with the successful server write so pausing
        // and reopening does not return to the path question.
        utils.settings.getOnboardingState.setData(undefined, (prev) =>
          prev
            ? {
                ...prev,
                onboardingIntent: state.onboardingIntent,
                journeyDismissed: false,
              }
            : prev,
        );
        return true;
      },
    });
  }, [register, saveIntent, state.onboardingIntent, utils]);

  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-slate-600">
        There is no all-or-nothing decision today. Pick the path that best fits
        how you want to get value from OpenVPM first.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {ONBOARDING_INTENT_OPTIONS.map((option) => {
          const Icon = intentIcons[option.value];
          const active = option.value === state.onboardingIntent;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => setState({ onboardingIntent: option.value })}
              className={cn(
                "relative rounded-xl border bg-white p-4 text-left transition-colors",
                active
                  ? "border-emerald-400 bg-emerald-50/60 ring-1 ring-emerald-400"
                  : "border-slate-200 hover:border-slate-300"
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                    active
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-600"
                  )}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-950">
                      {option.label}
                    </span>
                    {option.recommended ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
                        Recommended
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">
                    {option.description}
                  </span>
                </span>
                {active ? (
                  <Check className="h-5 w-5 shrink-0 text-emerald-600" />
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
          Your first win
        </p>
        <p className="mt-1 text-sm font-semibold text-slate-950">
          {selected.firstWin}
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          {selected.firstWinHint}
        </p>
      </div>
    </div>
  );
}
