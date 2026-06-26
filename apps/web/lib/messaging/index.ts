import { eq } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { locationMessaging } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { consoleProvider } from "./console";
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
  const override = process.env.MESSAGING_PROVIDER?.toLowerCase();
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
    : ["TELNYX_API_KEY", "TELNYX_MESSAGING_PROFILE_ID"];
}

/** Platform-wide env default sender for the active provider (dev + fallback). */
function envSender(): MessagingSender {
  if (getMessagingProvider().name === "twilio") {
    return {
      messagingServiceId: process.env.TWILIO_MESSAGING_SERVICE_SID || undefined,
      from: process.env.TWILIO_PHONE_NUMBER || undefined,
    };
  }
  return {
    messagingServiceId: process.env.TELNYX_MESSAGING_PROFILE_ID || undefined,
    from: process.env.TELNYX_FROM_NUMBER || undefined,
  };
}

/**
 * Resolve the sender for a practice/location. Prefers the location's own
 * configured number (each clinic texts from its own number — see number
 * strategy) read from `location_messaging`, and falls back to the platform-wide
 * env default (dev / not-yet-provisioned). A DB error falls back to env rather
 * than blocking the send.
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
          .where(eq(locationMessaging.locationId, opts.locationId!))
          .limit(1)
      );
      if (row && (row.messagingProfileId || row.senderE164)) {
        return {
          messagingServiceId: row.messagingProfileId ?? undefined,
          from: row.senderE164 ?? undefined,
        };
      }
    } catch (e) {
      console.error("[messaging] resolveSender lookup failed; using env default", e);
    }
  }
  return envSender();
}
