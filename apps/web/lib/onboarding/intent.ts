export const ONBOARDING_INTENTS = [
  "alongside",
  "replace",
  "explore",
  "self_host",
] as const;

export type OnboardingIntent = (typeof ONBOARDING_INTENTS)[number];

export const DEFAULT_ONBOARDING_INTENT: OnboardingIntent = "alongside";

export type OnboardingIntentOption = {
  value: OnboardingIntent;
  label: string;
  shortLabel: string;
  description: string;
  firstWin: string;
  firstWinHint: string;
  firstWinTarget: "tour" | "brand" | "data";
  recommended?: boolean;
};

export const ONBOARDING_INTENT_OPTIONS: readonly OnboardingIntentOption[] = [
  {
    value: "alongside",
    label: "Run alongside my current PIMS",
    shortLabel: "Alongside current PIMS",
    description:
      "Start with one useful workflow while your current system stays in place.",
    firstWin: "Bring over a small real dataset",
    firstWinHint:
      "Start with a few clients and pets. Your current PIMS stays in place.",
    firstWinTarget: "data",
    recommended: true,
  },
  {
    value: "replace",
    label: "Replace my current PIMS",
    shortLabel: "Replace current PIMS",
    description:
      "Prepare a staged move of your clinic data and day-to-day workflows.",
    firstWin: "Start your staged data import",
    firstWinHint:
      "Bring clients and pets in before switching live clinic workflows.",
    firstWinTarget: "data",
  },
  {
    value: "explore",
    label: "Explore with sample data",
    shortLabel: "Explore",
    description:
      "Learn the product first with a ready-made clinic and no migration decision.",
    firstWin: "Take the 60-second tour",
    firstWinHint: "See the schedule, records, billing, and AI in a minute.",
    firstWinTarget: "tour",
  },
  {
    value: "self_host",
    label: "Evaluate for self-hosting",
    shortLabel: "Self-host",
    description:
      "Learn the same open-source product while you plan or run your own deployment.",
    firstWin: "Brand your self-hosted workspace",
    firstWinHint:
      "Set clinic details first; hosted-only billing steps stay out of self-hosted setup.",
    firstWinTarget: "brand",
  },
];

export function isOnboardingIntent(value: unknown): value is OnboardingIntent {
  return ONBOARDING_INTENTS.includes(value as OnboardingIntent);
}

export function getOnboardingIntentOption(
  value: unknown
): OnboardingIntentOption {
  return (
    ONBOARDING_INTENT_OPTIONS.find((option) => option.value === value) ??
    ONBOARDING_INTENT_OPTIONS[0]!
  );
}

export function onboardingIntentLabel(value: unknown): string {
  if (!isOnboardingIntent(value)) return "Not selected";
  return getOnboardingIntentOption(value).shortLabel;
}
