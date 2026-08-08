export const CLOSEOUT_DIAGNOSIS_MAX_LENGTH = 5_000;
export const CLOSEOUT_INSTRUCTIONS_MAX_LENGTH = 10_000;
export const CLOSEOUT_WARNING_SIGNS_MAX_LENGTH = 5_000;
export const CLOSEOUT_REASON_MAX_LENGTH = 1_000;
export const CLOSEOUT_FOLLOW_UP_NOTES_MAX_LENGTH = 5_000;

export const CLOSEOUT_BYPASS_MESSAGE =
  "Review and complete the visit closeout before checking out this appointment.";

export function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
