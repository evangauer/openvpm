const HOUR_MS = 60 * 60 * 1000;

export const BUILD_FOLLOWUP_ENABLED_ENV = "BUILD_FOLLOWUP_ENABLED";
export const BUILD_FOLLOWUP_ROLLOUT_AT_ENV = "BUILD_FOLLOWUP_ROLLOUT_AT";
export const BUILD_FOLLOWUP_SEQUENCE = "build-followup";

export type BuildFollowupStep = 1 | 2;

/**
 * Two notes, counted from the last save, so someone still building is never
 * nudged mid-way. Matches the save disclosure: a resume link and one
 * follow-up.
 */
export const BUILD_FOLLOWUP_SCHEDULE: ReadonlyArray<{
  step: BuildFollowupStep;
  afterHours: number;
}> = [
  { step: 1, afterHours: 2 },
  { step: 2, afterHours: 72 },
];
export const BUILD_FOLLOWUP_MAX_EMAILS = BUILD_FOLLOWUP_SCHEDULE.length;
export const BUILD_FOLLOWUP_MIN_GAP_HOURS = 20;
export const BUILD_FOLLOWUP_MAX_AGE_HOURS = 14 * 24;

export type BuildFollowupConfig =
  | { enabled: false; reason: "disabled" | "rollout_at_invalid" }
  | { enabled: true; rolloutAt: Date };

/** Default-off and prospective: only builds saved after rollout. */
export function buildFollowupConfig(): BuildFollowupConfig {
  if (
    process.env[BUILD_FOLLOWUP_ENABLED_ENV]?.trim().toLowerCase() !== "true"
  ) {
    return { enabled: false, reason: "disabled" };
  }
  const rolloutAt = new Date(
    process.env[BUILD_FOLLOWUP_ROLLOUT_AT_ENV]?.trim() ?? "",
  );
  if (Number.isNaN(rolloutAt.getTime())) {
    return { enabled: false, reason: "rollout_at_invalid" };
  }
  return { enabled: true, rolloutAt };
}

export function buildFollowupDedupeKey(
  leadId: string,
  step: BuildFollowupStep,
): string {
  return `lead:${BUILD_FOLLOWUP_SEQUENCE}:v1:${leadId}:${step}`;
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function buildFollowupStepDue(input: {
  now: Date;
  savedAt: Date | string;
  existingEmailCount: number;
  lastEmailAt: Date | string | null;
}): BuildFollowupStep | null {
  const savedAt = validDate(input.savedAt);
  if (!savedAt) return null;
  const ageMs = input.now.getTime() - savedAt.getTime();
  if (ageMs < 0 || ageMs > BUILD_FOLLOWUP_MAX_AGE_HOURS * HOUR_MS) return null;
  const next = BUILD_FOLLOWUP_SCHEDULE[input.existingEmailCount];
  if (!next || ageMs < next.afterHours * HOUR_MS) return null;
  const lastEmailAt = validDate(input.lastEmailAt);
  if (
    lastEmailAt &&
    input.now.getTime() - lastEmailAt.getTime() <
      BUILD_FOLLOWUP_MIN_GAP_HOURS * HOUR_MS
  ) {
    return null;
  }
  return next.step;
}
