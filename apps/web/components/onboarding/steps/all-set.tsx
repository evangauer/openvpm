"use client";

import { useEffect } from "react";
import { CalendarPlus, UserPlus } from "lucide-react";
import { FirstDayRecommendations } from "@/components/onboarding/first-day-recommendations";
import type { JourneyState, StepHandle } from "../journey-types";

/**
 * Closing step: turn setup momentum into the first real clinic action. The
 * overlay completes guided setup and routes to the action named here.
 */
export function AllSetStep({
  register,
  state,
}: {
  register: (h: StepHandle) => void;
  state: JourneyState;
}) {
  const hasImportedData = state.hasImportedData;
  useEffect(() => {
    register({
      continueLabel: hasImportedData
        ? "Book the first appointment"
        : "Add the first real client",
      onContinue: async () => true,
    });
  }, [hasImportedData, register]);

  const Icon = hasImportedData ? CalendarPlus : UserPlus;

  return (
    <div className="space-y-7">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          {hasImportedData
            ? "Your reviewed records are saved. Start with one real appointment, then decide what deserves a larger rollout."
            : "Your clinic basics are saved. Start with one real client and visit while your current PIMS stays safely in place."}
        </p>
      </div>

      <FirstDayRecommendations hasImportedData={hasImportedData} />
    </div>
  );
}
