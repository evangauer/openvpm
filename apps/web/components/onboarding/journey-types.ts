/** Shared collected state and the per-step contract for the onboarding journey. */

import type { OnboardingIntent } from "@/lib/onboarding/intent";
import type { MigrationImportMode } from "@/lib/import/sources";

export interface JourneyState {
  /** The adoption path selected on the first setup step. */
  onboardingIntent: OnboardingIntent;
  /** When true, the seeded sample data stays put instead of being cleared at finish. */
  keepSampleData: boolean;
  /** A reviewed multi-file migration has committed at least one stage locally. */
  hasPartialImport: boolean;
  /** Sticky for this journey once reviewed real data has reached the practice. */
  hasImportedData: boolean;
  /** Source used by the latest reviewed migration, safe to persist without CSV data. */
  migrationSource?: string | null;
  /** True only when the latest source has committed material record changes. */
  migrationSourceHasCommittedChanges?: boolean;
  /** Stages already reviewed and completed in earlier sessions. */
  migrationCompletedModes?: MigrationImportMode[];
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
