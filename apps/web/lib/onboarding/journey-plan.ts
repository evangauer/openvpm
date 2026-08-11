export type OnboardingJourneyStepId = "intent" | "basics" | "data" | "allSet";

export interface OnboardingJourneyStep {
  id: OnboardingJourneyStepId;
  title: string;
}

/**
 * Guided setup should end at the first useful clinic action. Branding, team,
 * AI, texting, and billing stay available from the dashboard checklist, but
 * they do not stand between signup and a real client or appointment.
 */
export const ONBOARDING_JOURNEY_STEPS: readonly OnboardingJourneyStep[] = [
  { id: "intent", title: "How do you want to start?" },
  { id: "basics", title: "Tell us about your clinic." },
  { id: "data", title: "Bring your clinic records." },
  { id: "allSet", title: "Start your first clinic day." },
];

const retiredStepIds = new Set([
  "branding",
  "team",
  "agent",
  "phone",
  "billing",
]);

/**
 * Preserve progress from the former nine-step journey. A clinic paused on a
 * retired setup chore resumes at real data (or the first-day handoff when a
 * reviewed migration already committed) instead of being sent back to step 1.
 */
export function onboardingJourneyResumeIndex(input: {
  onboardingIntent: string | null | undefined;
  journeyStepId: string | null | undefined;
  migrationHasCommittedChanges: boolean;
}): number {
  if (!input.onboardingIntent) return 0;

  const currentIndex = ONBOARDING_JOURNEY_STEPS.findIndex(
    (step) => step.id === input.journeyStepId,
  );
  if (currentIndex >= 0) return currentIndex;

  if (input.journeyStepId && retiredStepIds.has(input.journeyStepId)) {
    return ONBOARDING_JOURNEY_STEPS.findIndex(
      (step) =>
        step.id === (input.migrationHasCommittedChanges ? "allSet" : "data"),
    );
  }

  return 0;
}
