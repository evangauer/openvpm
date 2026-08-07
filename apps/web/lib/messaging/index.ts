import { and, eq, isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { locationMessaging, locations } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { consoleProvider } from "./console";
import { envValue, nonBlank } from "./env";
import { hasNonBlankMessagingSender } from "./sender-query";
import { telnyxProvider } from "./telnyx";
import { twilioProvider } from "./twilio";
import type { MessagingProvider, MessagingSender } from "./types";

export * from "./types";
export { normalizeE164 } from "./phone";
export { isSuppressed, addSuppression, removeSuppression } from "./suppression";

/**
 * Resolve the active messaging provider. Explicit override via MESSAGING_PROVIDER
 * (telnyx|twilio), else the first configured provider (Telnyx preferred), else a
 * console fallback that logs instead of sending (local dev / CI). Mirrors the
 * provider-agnostic selection in lib/agent/runner.ts.
 */
export function getMessagingProvider(): MessagingProvider {
  // Demo deployments never send real messages, regardless of configured creds —
  // the demo is purely a demo. This is the single chokepoint for all sends.
  if (envValue("NEXT_PUBLIC_DEMO_MODE") === "true") return consoleProvider;
  const override = envValue("MESSAGING_PROVIDER")?.toLowerCase();
  if (override === "telnyx") return telnyxProvider;
  if (override === "twilio") return twilioProvider;
  if (telnyxProvider.isConfigured()) return telnyxProvider;
  if (twilioProvider.isConfigured()) return twilioProvider;
  return consoleProvider;
}

/** Env names the active provider needs, for the hosted /api/health check. */
export function requiredMessagingEnvNames(): string[] {
  return getMessagingProvider().name === "twilio"
    ? ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"]
    : [
        "TELNYX_API_KEY",
        "TELNYX_MESSAGING_PROFILE_ID",
        "TELNYX_PUBLIC_KEY",
        "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
      ];
}

/** Platform-wide env default sender for the active provider (dev + fallback). */
function envSender(): MessagingSender {
  if (getMessagingProvider().name === "twilio") {
    return {
      messagingServiceId: envValue("TWILIO_MESSAGING_SERVICE_SID"),
      from: envValue("TWILIO_PHONE_NUMBER"),
    };
  }
  return {
    messagingServiceId: envValue("TELNYX_MESSAGING_PROFILE_ID"),
    from: envValue("TELNYX_FROM_NUMBER"),
  };
}

/**
 * Resolve the sender for a practice/location. Calls with a location id must use
 * that location's active texting setup; calls without a location id fall back to
 * the platform-wide env default for dev / not-yet-provisioned workflows. A DB
 * error falls back to env only when there was no explicit location target.
 */
export async function resolveSender(opts: {
  practiceId?: string;
  locationId?: string;
}): Promise<MessagingSender> {
  if (opts.locationId) {
    try {
      const [row] = await withSystem(db, (tx) =>
        tx
          .select({
            messagingProfileId: locationMessaging.messagingProfileId,
            senderE164: locationMessaging.senderE164,
          })
          .from(locationMessaging)
          .innerJoin(
            locations,
            and(
              eq(locations.id, locationMessaging.locationId),
              opts.practiceId
                ? eq(locations.practiceId, opts.practiceId)
                : eq(locations.practiceId, locationMessaging.practiceId),
              isNull(locations.deletedAt)
            )
          )
          .where(
            opts.practiceId
              ? and(
                  eq(locationMessaging.locationId, opts.locationId!),
                  eq(locationMessaging.practiceId, opts.practiceId),
                  isNull(locationMessaging.deletedAt),
                  eq(locations.practiceId, opts.practiceId),
                  isNull(locations.deletedAt),
                  eq(locationMessaging.enabled, true),
                  eq(locationMessaging.registrationStatus, "active"),
                  hasNonBlankMessagingSender()
                )
              : and(
                  eq(locationMessaging.locationId, opts.locationId!),
                  isNull(locationMessaging.deletedAt),
                  isNull(locations.deletedAt),
                  eq(locationMessaging.enabled, true),
                  eq(locationMessaging.registrationStatus, "active"),
                  hasNonBlankMessagingSender()
                )
          )
          .limit(1)
      );
      if (row) {
        const messagingServiceId = nonBlank(row.messagingProfileId);
        const from = nonBlank(row.senderE164);
        if (!messagingServiceId && !from) return {};
        return {
          messagingServiceId,
          from,
        };
      }
    } catch (e) {
      console.error("[messaging] resolveSender lookup failed", e);
    }
    return {};
  }
  return envSender();
}
