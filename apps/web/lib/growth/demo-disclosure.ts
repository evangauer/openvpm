/**
 * What the demo email gate tells visitors their address is used for. The copy
 * and its version live together: changing what we promise means bumping the
 * version, and follow-up email never exceeds what a lead's version promised.
 *
 * Safe for client components (no server imports).
 */
export const DEMO_DISCLOSURE_FEEDBACK_V1 = "demo-feedback-v1";
export const DEMO_DISCLOSURE_FOLLOWUP_V2 = "demo-followup-v2";
export const DEMO_DISCLOSURE_USEFUL_V3 = "demo-useful-v3";

export const DEMO_DISCLOSURE_VERSIONS = [
  DEMO_DISCLOSURE_FEEDBACK_V1,
  DEMO_DISCLOSURE_FOLLOWUP_V2,
  DEMO_DISCLOSURE_USEFUL_V3,
] as const;

export type DemoDisclosureVersion = (typeof DEMO_DISCLOSURE_VERSIONS)[number];

export const CURRENT_DEMO_DISCLOSURE: DemoDisclosureVersion =
  DEMO_DISCLOSURE_USEFUL_V3;

export const CURRENT_DEMO_DISCLOSURE_TEXT =
  "This helps us block spam and repeat abuse. We’ll only reach out when there’s something useful to share. Unsubscribe anytime.";

export function isDemoDisclosureVersion(
  value: unknown,
): value is DemoDisclosureVersion {
  return (
    typeof value === "string" &&
    (DEMO_DISCLOSURE_VERSIONS as readonly string[]).includes(value)
  );
}
