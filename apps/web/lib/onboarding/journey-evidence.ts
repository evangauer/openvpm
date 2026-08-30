import {
  ONBOARDING_JOURNEY_STEP_IDS,
  type OnboardingJourneyStepId,
} from "./journey-plan";

export const ONBOARDING_JOURNEY_EVIDENCE_VERSION = 1;
export const MAX_ONBOARDING_JOURNEY_REVISION = 2_147_483_646;

export type OnboardingJourneyEvidenceMode =
  | "prospective"
  | "legacy"
  | "invalid";

export interface OnboardingJourneyEvidenceState {
  journeyEvidenceVersion?: unknown;
  journeyRevision?: unknown;
  journeyStepId?: unknown;
  journeyDismissed?: unknown;
  onboardingIntent?: unknown;
  onboardingIntentSelectedAt?: unknown;
  journeyIntentCompletedAt?: unknown;
  journeyBasicsCompletedAt?: unknown;
  journeyDataCompletedAt?: unknown;
  journeyAllSetCompletedAt?: unknown;
}

export function onboardingJourneyEvidenceMode(
  state: OnboardingJourneyEvidenceState | null | undefined,
): OnboardingJourneyEvidenceMode {
  const value = state?.journeyEvidenceVersion;
  if (value === undefined || value === null) return "legacy";
  return value === ONBOARDING_JOURNEY_EVIDENCE_VERSION
    ? "prospective"
    : "invalid";
}

export function onboardingJourneyRevision(
  state: OnboardingJourneyEvidenceState | null | undefined,
): { revision: number; valid: boolean } {
  const value = state?.journeyRevision;
  if (value === undefined || value === null) {
    return { revision: 0, valid: true };
  }
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_ONBOARDING_JOURNEY_REVISION
    ? { revision: value, valid: true }
    : { revision: 0, valid: false };
}

export function canonicalJourneyStep(
  value: unknown,
): OnboardingJourneyStepId | null {
  return typeof value === "string" &&
    ONBOARDING_JOURNEY_STEP_IDS.includes(value as OnboardingJourneyStepId)
    ? (value as OnboardingJourneyStepId)
    : null;
}

function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

function time(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function boundedJourneyTimestamp(
  value: unknown,
  createdAt: Date | string,
  dbNow: Date | string,
): boolean {
  const parsed = timestamp(value);
  const lower = time(createdAt);
  const upper = time(dbNow);
  return (
    Number.isFinite(parsed) &&
    Number.isFinite(lower) &&
    Number.isFinite(upper) &&
    parsed >= lower &&
    parsed <= upper
  );
}

export function orderedProspectiveJourneyEvidence(
  state: OnboardingJourneyEvidenceState,
  createdAt: Date | string,
  dbNow: Date | string,
): { intent: boolean; basics: boolean; data: boolean; allSet: boolean } {
  const intentAt = timestamp(state.journeyIntentCompletedAt);
  const basicsAt = timestamp(state.journeyBasicsCompletedAt);
  const dataAt = timestamp(state.journeyDataCompletedAt);
  const allSetAt = timestamp(state.journeyAllSetCompletedAt);
  const intent = boundedJourneyTimestamp(
    state.journeyIntentCompletedAt,
    createdAt,
    dbNow,
  );
  const basics =
    intent &&
    boundedJourneyTimestamp(state.journeyBasicsCompletedAt, createdAt, dbNow) &&
    basicsAt >= intentAt;
  const data =
    basics &&
    boundedJourneyTimestamp(state.journeyDataCompletedAt, createdAt, dbNow) &&
    dataAt >= basicsAt;
  const allSet =
    data &&
    boundedJourneyTimestamp(state.journeyAllSetCompletedAt, createdAt, dbNow) &&
    allSetAt >= dataAt;
  return { intent, basics, data, allSet };
}

export function durableOnboardingIntentEvidence(
  state: OnboardingJourneyEvidenceState,
  createdAt: Date | string,
  dbNow: Date | string,
): boolean {
  return (
    typeof state.onboardingIntent === "string" &&
    state.onboardingIntent.length > 0 &&
    boundedJourneyTimestamp(state.onboardingIntentSelectedAt, createdAt, dbNow)
  );
}

export function journeyTransitionStage(input: {
  currentStepId: OnboardingJourneyStepId | null;
  targetStepId: OnboardingJourneyStepId;
  dismissed: boolean | undefined;
  durableIntent: boolean;
}): OnboardingJourneyStepId | null | undefined {
  const { currentStepId, targetStepId, dismissed, durableIntent } = input;
  if (currentStepId === null) {
    return targetStepId === "intent" && dismissed !== true ? null : undefined;
  }

  const currentIndex = ONBOARDING_JOURNEY_STEP_IDS.indexOf(currentStepId);
  const targetIndex = ONBOARDING_JOURNEY_STEP_IDS.indexOf(targetStepId);
  const distance = targetIndex - currentIndex;
  if (Math.abs(distance) > 1) return undefined;
  if (dismissed === true && distance !== 0) return undefined;
  if (
    currentStepId === "intent" &&
    targetStepId === "basics" &&
    !durableIntent
  ) {
    return undefined;
  }
  return distance === 1 ? currentStepId : null;
}

export function prospectivePredecessorIsValid(input: {
  completedStage: OnboardingJourneyStepId;
  evidence: ReturnType<typeof orderedProspectiveJourneyEvidence>;
  existingStageTimestamp: unknown;
}): boolean {
  const { completedStage, evidence, existingStageTimestamp } = input;
  switch (completedStage) {
    case "intent":
      return evidence.intent;
    case "basics":
      return existingStageTimestamp == null ? evidence.intent : evidence.basics;
    case "data":
      return existingStageTimestamp == null ? evidence.basics : evidence.data;
    case "allSet":
      return existingStageTimestamp == null ? evidence.data : evidence.allSet;
  }
}
