"use client";

import { useEffect } from "react";
import { ClinicIntentBuilder } from "@/components/onboarding/clinic-intent-builder";
import { FUNNEL_EVENTS } from "@/lib/funnel-analytics";
import {
  onboardingIntentForGoal,
  type ClinicModel,
  type FirstGoal,
} from "@/lib/onboarding/clinic-profile";
import { trackFunnelEvent } from "@/lib/track-funnel-event";
import { trpc } from "@/lib/trpc";
import type { StepProps } from "../journey-types";

/**
 * Personalize the workspace around a coarse care model and first outcome.
 * Neither value contains patient, client, or clinical information.
 */
export function ChoosePathStep({ register, state, setState }: StepProps) {
  const utils = trpc.useUtils();
  const saveIntent = trpc.settings.setOnboardingIntent.useMutation();

  useEffect(() => {
    register({
      continueLabel: "Build my first day",
      async onContinue() {
        await saveIntent.mutateAsync({
          intent: state.onboardingIntent,
          clinicModel: state.clinicModel,
          firstGoal: state.firstGoal,
        });
        utils.settings.getOnboardingState.setData(undefined, (prev) =>
          prev
            ? {
                ...prev,
                onboardingIntent: state.onboardingIntent,
                clinicModel: state.clinicModel,
                firstGoal: state.firstGoal,
                journeyDismissed: false,
              }
            : prev,
        );
        trackFunnelEvent(FUNNEL_EVENTS.onboardingPlanBuilt, {
          model: state.clinicModel,
          goal: state.firstGoal,
          step: "workspace",
        });
        return true;
      },
    });
  }, [register, saveIntent, state, utils]);

  function selectModel(model: ClinicModel) {
    const nextGoal =
      model === "exploring" || state.firstGoal !== "self_host"
        ? state.firstGoal
        : "explore_sample";
    setState({
      clinicModel: model,
      firstGoal: nextGoal,
      onboardingIntent: onboardingIntentForGoal(nextGoal),
    });
    trackFunnelEvent(FUNNEL_EVENTS.onboardingModelSelected, {
      model,
      step: "workspace",
    });
  }

  function selectGoal(goal: FirstGoal) {
    setState({
      firstGoal: goal,
      onboardingIntent: onboardingIntentForGoal(goal),
    });
    trackFunnelEvent(FUNNEL_EVENTS.onboardingGoalSelected, {
      model: state.clinicModel,
      goal,
      step: "workspace",
    });
  }

  return (
    <ClinicIntentBuilder
      clinicModel={state.clinicModel}
      firstGoal={state.firstGoal}
      onClinicModelChange={selectModel}
      onFirstGoalChange={selectGoal}
    />
  );
}
