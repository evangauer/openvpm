"use client";

import { useEffect } from "react";
import { CalendarPlus, UserPlus } from "lucide-react";
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
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
          <Icon className="h-5 w-5" />
        </span>
        <p className="text-sm leading-6 text-slate-600">
          {hasImportedData
            ? "Your reviewed records are saved. Book one real appointment next, then run that visit from check-in through checkout before changing your clinic's live workflow."
            : "Your clinic basics are saved. Add one real client and pet next. Your current PIMS can stay in place while you validate the complete visit with your team."}
        </p>
      </div>

      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
          What happens next
        </p>
        <p className="mt-1 text-sm font-semibold text-slate-950">
          {hasImportedData
            ? "Choose a pet and put the first visit on the schedule."
            : "Create one owner, add their pet, and book the first visit."}
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Branding, teammates, AI, texting, and billing remain in your dashboard
          checklist. None of them blocks this first clinic test.
        </p>
      </div>
    </div>
  );
}
