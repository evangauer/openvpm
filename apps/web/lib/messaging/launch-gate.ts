import { envFlagEnabled } from "@/lib/env-bool";

export const MESSAGING_SENDING_ENABLED_ENV = "MESSAGING_SENDING_ENABLED";
export const MESSAGING_SENDING_PRACTICE_IDS_ENV =
  "MESSAGING_SENDING_PRACTICE_IDS";
export const MESSAGING_SENDING_LOCATION_IDS_ENV =
  "MESSAGING_SENDING_LOCATION_IDS";

export type HostedMessagingLaunchBlock =
  | "platform_disabled"
  | "missing_scope"
  | "practice_not_allowed"
  | "location_not_allowed";

export type HostedMessagingLaunchDecision =
  | { allowed: true }
  | { allowed: false; reason: HostedMessagingLaunchBlock };

function allowlist(name: string): ReadonlySet<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

/**
 * Hosted SMS is an operator-controlled pilot. All three switches are required:
 * the global default-off flag, the practice allowlist, and the location
 * allowlist. Empty, malformed, or partial configuration therefore fails closed.
 *
 * Self-host callers must skip this policy and retain their explicit provider
 * configuration; this helper intentionally describes hosted rollout only.
 */
export function hostedMessagingLaunchDecision(opts: {
  practiceId?: string;
  locationId?: string;
}): HostedMessagingLaunchDecision {
  if (!envFlagEnabled(MESSAGING_SENDING_ENABLED_ENV)) {
    return { allowed: false, reason: "platform_disabled" };
  }
  if (!opts.practiceId?.trim() || !opts.locationId?.trim()) {
    return { allowed: false, reason: "missing_scope" };
  }
  if (!allowlist(MESSAGING_SENDING_PRACTICE_IDS_ENV).has(opts.practiceId)) {
    return { allowed: false, reason: "practice_not_allowed" };
  }
  if (!allowlist(MESSAGING_SENDING_LOCATION_IDS_ENV).has(opts.locationId)) {
    return { allowed: false, reason: "location_not_allowed" };
  }
  return { allowed: true };
}

export function hostedMessagingLaunchBlockMessage(
  reason: HostedMessagingLaunchBlock
): string {
  if (reason === "missing_scope") {
    return "Hosted SMS requires an explicit clinic practice and location.";
  }
  return "Texting is not enabled for this clinic pilot. Contact OpenVPM support.";
}
