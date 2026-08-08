/** Shared collected state and the per-step contract for the onboarding journey. */

import type { OnboardingIntent } from "@/lib/onboarding/intent";

export interface JourneyState {
  /** The adoption path selected on the first setup step. */
  onboardingIntent: OnboardingIntent;
  /** When true, the seeded sample data stays put instead of being cleared at finish. */
  keepSampleData: boolean;
  /** When true, finishing the wizard launches the quick product tour. */
  startTourAfter: boolean;
}

export interface StepHandle {
  /** Optional action label for steps that perform a material operation. */
  continueLabel?: string;
  /** Prevent advancing while a step is still preparing local input. */
  continueDisabled?: boolean;
  /**
   * Runs when the user presses Continue (or Finish). Do the step's own server
   * work here and return true to advance. Returning false (or throwing) keeps
   * the user on the step; the overlay surfaces the error via a toast.
   */
  onContinue: () => Promise<boolean>;
}

export interface StepProps {
  /** Register this step's Continue handler with the overlay. */
  register: (handle: StepHandle) => void;
  /** Read + update the small bag of state shared across steps. */
  state: JourneyState;
  setState: (patch: Partial<JourneyState>) => void;
}
