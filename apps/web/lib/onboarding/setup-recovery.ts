const HOUR_MS = 60 * 60 * 1000;

export const SETUP_RECOVERY_VERSION = "v1";
export const SETUP_RECOVERY_FIRST_STALL_HOURS = 24;
export const SETUP_RECOVERY_SECOND_STALL_HOURS = 72;
export const SETUP_RECOVERY_COOLDOWN_HOURS = 72;
export const SETUP_RECOVERY_MINIMUM_TRIAL_HOURS = 48;
export const SETUP_RECOVERY_MAX_EMAILS = 2;

export type SetupRecoveryStage = "start" | "basics" | "data" | "first_day";
export type SetupRecoveryAttempt = 1 | 2;

type OnboardingSettings = {
  onboardingCompletedAt?: string | null;
  onboardingState?: {
    onboardingIntent?: string | null;
    onboardingIntentSelectedAt?: string | null;
    journeyStepId?: string | null;
    journeyLastProgressAt?: string | null;
    setupHelpRequestedAt?: string | null;
  };
};

export interface SetupRecoveryState {
  completed: boolean;
  selfHost: boolean;
  helpRequested: boolean;
  stage: SetupRecoveryStage;
  lastProgressAt: Date;
}

export interface SetupRecoveryCopy {
  stepTitle: string;
  nextAction: string;
}

function validDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stageFromStep(step: string | null | undefined): SetupRecoveryStage {
  switch (step) {
    case "basics":
      return "basics";
    case "data":
      return "data";
    case "allSet":
      return "first_day";
    // Retired setup chores now resume at data in the live journey.
    case "branding":
    case "team":
    case "agent":
    case "phone":
    case "billing":
      return "data";
    default:
      return "start";
  }
}

export function setupRecoveryState(
  settingsValue: unknown,
  createdAtValue: Date | string,
): SetupRecoveryState {
  const settings = (settingsValue ?? {}) as OnboardingSettings;
  const state = settings.onboardingState;
  const createdAt =
    createdAtValue instanceof Date ? createdAtValue : new Date(createdAtValue);
  const safeCreatedAt = Number.isNaN(createdAt.getTime())
    ? new Date(0)
    : createdAt;

  return {
    completed: validDate(settings.onboardingCompletedAt) != null,
    selfHost: state?.onboardingIntent === "self_host",
    helpRequested: validDate(state?.setupHelpRequestedAt) != null,
    stage: stageFromStep(state?.journeyStepId),
    lastProgressAt:
      validDate(state?.journeyLastProgressAt) ??
      validDate(state?.onboardingIntentSelectedAt) ??
      safeCreatedAt,
  };
}

export function setupRecoveryCopy(
  stage: SetupRecoveryStage,
): SetupRecoveryCopy {
  switch (stage) {
    case "basics":
      return {
        stepTitle: "your clinic basics",
        nextAction:
          "Confirm your clinic country, time zone, and contact details. This keeps scheduling, billing, and rollout guidance accurate.",
      };
    case "data":
      return {
        stepTitle: "bringing in your clinic records",
        nextAction:
          "Start with one small client or patient file, keep the sample workspace while you explore, or request a private migration review.",
      };
    case "first_day":
      return {
        stepTitle: "your first clinic day",
        nextAction:
          "Finish the handoff, then add one real client and appointment. Branding, texting, team invites, and billing can wait.",
      };
    case "start":
      return {
        stepTitle: "choosing how to start",
        nextAction:
          "Tell us your clinic country and whether OpenVPM will replace, run alongside, or simply be evaluated against your current PIMS.",
      };
  }
}

export function setupRecoveryAttempt(input: {
  now: Date;
  billingStatus: string;
  trialEndsAt: Date | string | null;
  activated: boolean;
  state: SetupRecoveryState;
  existingEmailCount: number;
  lastEmailAt: Date | string | null;
}): SetupRecoveryAttempt | null {
  if (
    input.billingStatus !== "trialing" ||
    input.activated ||
    input.state.completed ||
    input.state.selfHost ||
    input.state.helpRequested
  ) {
    return null;
  }

  const trialEndsAt = input.trialEndsAt ? new Date(input.trialEndsAt) : null;
  if (
    !trialEndsAt ||
    Number.isNaN(trialEndsAt.getTime()) ||
    trialEndsAt.getTime() - input.now.getTime() <
      SETUP_RECOVERY_MINIMUM_TRIAL_HOURS * HOUR_MS
  ) {
    return null;
  }

  const count = Math.max(0, Math.floor(input.existingEmailCount));
  if (count >= SETUP_RECOVERY_MAX_EMAILS) return null;

  const stalledFor = input.now.getTime() - input.state.lastProgressAt.getTime();
  if (count === 0) {
    return stalledFor >= SETUP_RECOVERY_FIRST_STALL_HOURS * HOUR_MS ? 1 : null;
  }

  const lastEmailAt = input.lastEmailAt ? new Date(input.lastEmailAt) : null;
  if (!lastEmailAt || Number.isNaN(lastEmailAt.getTime())) return null;
  const sinceLastEmail = input.now.getTime() - lastEmailAt.getTime();
  return stalledFor >= SETUP_RECOVERY_SECOND_STALL_HOURS * HOUR_MS &&
    sinceLastEmail >= SETUP_RECOVERY_COOLDOWN_HOURS * HOUR_MS
    ? 2
    : null;
}

export function setupRecoveryDedupeKey(
  practiceId: string,
  attempt: SetupRecoveryAttempt,
): string {
  return `lc:setup-recovery:${SETUP_RECOVERY_VERSION}:${practiceId}:${attempt}`;
}
