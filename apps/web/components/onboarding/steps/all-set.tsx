"use client";

import { useEffect } from "react";
import { CalendarPlus, CreditCard, UserPlus } from "lucide-react";
import { FirstDayRecommendations } from "@/components/onboarding/first-day-recommendations";
import { trpc } from "@/lib/trpc";
import { TRIAL_DAYS } from "@/lib/billing/plans";
import type { JourneyState, StepHandle } from "../journey-types";

/**
 * Closing step: turn setup momentum into the first real clinic action. The
 * overlay completes guided setup and routes to the action named here. A clinic
 * still in its preview sees the workspace it just shaped, then is asked for
 * the card that starts its trial.
 */
export function AllSetStep({
  register,
  state,
}: {
  register: (h: StepHandle) => void;
  state: JourneyState;
}) {
  const hasImportedData = state.hasImportedData;
  const subscription = trpc.subscription.get.useQuery(undefined, {
    retry: false,
  });
  const inPreview = subscription.data?.previewActive === true;

  useEffect(() => {
    register(
      inPreview
        ? {
            continueLabel: "Start my free trial",
            finishPath: "/settings?tab=billing&from=setup",
            onContinue: async () => true,
          }
        : {
            continueLabel: hasImportedData
              ? "Book the first appointment"
              : "Add the first real client",
            onContinue: async () => true,
          },
    );
  }, [hasImportedData, inPreview, register]);

  const Icon = hasImportedData ? CalendarPlus : UserPlus;

  return (
    <div className="space-y-7">
      {inPreview ? (
        <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <CreditCard className="h-5 w-5" />
          </span>
          <div className="max-w-3xl text-sm leading-6 text-slate-700">
            <p className="font-medium text-slate-900">
              This is your clinic in OpenVPM. Ready to run it for real?
            </p>
            <p className="mt-1">
              {`Start your ${TRIAL_DAYS}-day free trial to email and text clients, use the AI assistant, and invite your team. No charge until the trial ends, and everything you set up stays. Prefer to keep exploring? The trial button stays in the top bar.`}
            </p>
          </div>
        </div>
      ) : null}

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
