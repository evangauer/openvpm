export const FIRST_CLINIC_WIN_ENABLED_ENV = "FIRST_CLINIC_WIN_ENABLED";
export const FIRST_CLINIC_WIN_ROLLOUT_AT_ENV = "FIRST_CLINIC_WIN_ROLLOUT_AT";

export type FirstClinicWinConfig =
  | { enabled: false; reason: "disabled" | "rollout_at_invalid" }
  | { enabled: true; rolloutAt: Date };

/**
 * Prospective-only campaign gate. A launch timestamp is mandatory so a new
 * deployment cannot unexpectedly email every historical trial clinic.
 */
export function firstClinicWinConfig(): FirstClinicWinConfig {
  if (
    process.env[FIRST_CLINIC_WIN_ENABLED_ENV]?.trim().toLowerCase() !== "true"
  ) {
    return { enabled: false, reason: "disabled" };
  }

  const rolloutAt = new Date(
    process.env[FIRST_CLINIC_WIN_ROLLOUT_AT_ENV]?.trim() ?? "",
  );
  if (Number.isNaN(rolloutAt.getTime())) {
    return { enabled: false, reason: "rollout_at_invalid" };
  }
  return { enabled: true, rolloutAt };
}
