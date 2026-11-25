/**
 * Scribe is dark by default. Two gates must both be open before anyone sees or
 * can call it:
 *
 * 1. the deployment switch below, and
 * 2. the clinic's own opt-in (`practices.settings.scribe.enabled`).
 *
 * The switch is a NEXT_PUBLIC variable on purpose: with it unset, the browser
 * never asks the server about Scribe, so a deployment that has not turned it on
 * behaves exactly as it did before this module existed.
 */

export const SCRIBE_ENABLED_ENV = "NEXT_PUBLIC_SCRIBE_ENABLED";
export const SCRIBE_PATH = "/scribe";

export function scribeRolloutEnabled(): boolean {
  // Literal property access so the value is inlined into client bundles.
  return process.env.NEXT_PUBLIC_SCRIBE_ENABLED?.trim() === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Practice settings are schemaless JSON. Anything other than an explicit
 * `true` is off, so a malformed value can never open the tool.
 */
export function scribePracticeEnabled(practiceSettings: unknown): boolean {
  if (!isRecord(practiceSettings)) return false;
  const candidate = practiceSettings.scribe;
  return isRecord(candidate) && candidate.enabled === true;
}

/** A clinic's stored opt-in counts only while the deployment switch is on. */
export function effectiveScribeEnabled(practiceSettings: unknown): boolean {
  return scribeRolloutEnabled() && scribePracticeEnabled(practiceSettings);
}

/** Scribe drafts clinical notes, so it follows the SOAP-writing roles. */
export function canUseScribeRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian";
}
