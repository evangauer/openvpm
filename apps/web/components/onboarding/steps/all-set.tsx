"use client";

import { useEffect } from "react";
import { PartyPopper, Compass } from "lucide-react";
import { cn } from "@/lib/utils";
import type { JourneyState, StepHandle } from "../journey-types";

/**
 * Closing step: celebrate, then offer a quick product tour. The choice sets
 * `startTourAfter`; the overlay's finish() launches the tour when it's on.
 * Continue ("Finish") always advances.
 */
export function AllSetStep({
  register,
  state,
  setState,
}: {
  register: (h: StepHandle) => void;
  state: JourneyState;
  setState: (patch: Partial<JourneyState>) => void;
}) {
  useEffect(() => {
    register({ onContinue: async () => true });
  }, [register]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
          <PartyPopper className="h-5 w-5" />
        </span>
        <p className="text-sm leading-6 text-slate-600">
          You finished the guided setup. Before switching clinic workflows,
          use the launch checklist on your dashboard to validate a real visit,
          appointment requests, payments, and communications with your team.
          Want a quick look around first?
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setState({ startTourAfter: true })}
          className={cn(
            "rounded-lg border p-4 text-left transition-colors",
            state.startTourAfter
              ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500"
              : "border-slate-200 hover:border-slate-300"
          )}
        >
          <Compass className="h-5 w-5 text-emerald-700" />
          <p className="mt-2 text-sm font-medium text-slate-900">
            Take the quick tour
          </p>
          <p className="mt-1 text-xs text-slate-500">
            A 60-second walk through the schedule, records, billing, and AI.
          </p>
        </button>

        <button
          type="button"
          onClick={() => setState({ startTourAfter: false })}
          className={cn(
            "rounded-lg border p-4 text-left transition-colors",
            !state.startTourAfter
              ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500"
              : "border-slate-200 hover:border-slate-300"
          )}
        >
          <PartyPopper className="h-5 w-5 text-emerald-700" />
          <p className="mt-2 text-sm font-medium text-slate-900">
            Jump right in
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Head straight to your dashboard. You can take the tour anytime.
          </p>
        </button>
      </div>
    </div>
  );
}
