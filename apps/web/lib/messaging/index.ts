import { and, eq, isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { locationMessaging, locations } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { consoleProvider } from "./console";
import { envValue, nonBlank } from "./env";
import { hasNonBlankMessagingSender } from "./sender-query";
import { telnyxProvider } from "./telnyx";
import { twilioProvider } from "./twilio";
import type {
  MessagingProvider,
  MessagingProviderName,
  MessagingSender,
  ResolvedMessagingTransport,
} from "./types";

export * from "./types";
export { normalizeE164 } from "./phone";
export {
  isSuppressed,
  addSuppression,
  removeSuppression,
  acquireSmsRecipientLockInTransaction,
  revokeSmsConsentAfterRecipientLockInTransaction,
  revokeSmsConsentByPhone,
  revokeSmsConsentByPhoneInTransaction,
} from "./suppression";

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
        "TELNYX_PUBLIC_KEY",
        "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
      ];
}

/** Platform-wide env default sender for the active provider (dev + fallback). */
function envSender(providerName: MessagingProviderName): MessagingSender {
  if (providerName === "twilio") {
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

/** Resolve a persisted provider name without consulting global provider env. */
function providerByName(name: string): MessagingProvider | undefined {
  if (name === "telnyx") return telnyxProvider;
  if (name === "twilio") return twilioProvider;
  return undefined;
}

/**
 * Resolve the provider and sender for a practice/location as one transport.
 * Calls with a location id must use that location's active texting setup; calls
 * without a location id fall back to the platform-wide env defaults for dev.
 * Explicit locations never fall back after a missing, invalid, or failed lookup.
 */
export async function resolveMessagingTransport(opts: {
  practiceId?: string;
  locationId?: string;
  /** Hosted pilot resolution is Telnyx-only and unambiguous per practice. */
  hosted?: boolean;
}): Promise<ResolvedMessagingTransport | undefined> {
  if (opts.locationId) {
    // A location UUID is not an authorization boundary. Never resolve an
    // explicit clinic sender unless its owning practice is supplied too.
    if (!opts.practiceId) return undefined;
    try {
      const rows = await withSystem(db, (tx) =>
        tx
          .select({
            locationId: locationMessaging.locationId,
            provider: locationMessaging.provider,
            messagingProfileId: locationMessaging.messagingProfileId,
            senderE164: locationMessaging.senderE164,
          })
          .from(locationMessaging)
          .innerJoin(
            locations,
            and(
              eq(locations.id, locationMessaging.locationId),
              eq(locations.practiceId, opts.practiceId!),
              isNull(locations.deletedAt)
            )
          )
          .where(
            opts.hosted
              ? and(
                  eq(locationMessaging.practiceId, opts.practiceId!),
                  isNull(locationMessaging.deletedAt),
                  eq(locations.practiceId, opts.practiceId!),
                  isNull(locations.deletedAt),
                  eq(locationMessaging.enabled, true),
                  eq(locationMessaging.registrationStatus, "active"),
                  hasNonBlankMessagingSender()
                )
              : and(
                  eq(locationMessaging.locationId, opts.locationId!),
                  eq(locationMessaging.practiceId, opts.practiceId!),
                  isNull(locationMessaging.deletedAt),
                  eq(locations.practiceId, opts.practiceId!),
                  isNull(locations.deletedAt),
                  eq(locationMessaging.enabled, true),
                  eq(locationMessaging.registrationStatus, "active"),
                  hasNonBlankMessagingSender()
                )
          )
          .limit(opts.hosted ? 2 : 1)
      );
      // Hosted rollout is deliberately one location per practice. More than
      // one active/enabled sender is ambiguous and must never become “first row
      // wins”; the selected row must also be the explicitly requested location.
      const row = opts.hosted
        ? rows.length === 1 && rows[0]?.provider === "telnyx"
          ? rows[0]
          : undefined
        : rows[0];
      if (row) {
        if (opts.hosted && row.locationId !== opts.locationId) return undefined;
        const messagingServiceId = nonBlank(row.messagingProfileId);
        const from = nonBlank(row.senderE164);
        if (!messagingServiceId && !from) return undefined;
        // Demo is the only permitted override for an explicit location: it must
        // never send externally even if that location has live provider config.
        const provider =
          envValue("NEXT_PUBLIC_DEMO_MODE") === "true"
            ? consoleProvider
            : providerByName(row.provider);
        if (!provider) return undefined;
        return {
          provider,
          sender: {
            messagingServiceId,
            from,
          },
        };
      }
    } catch (e) {
      console.error("[messaging] resolveMessagingTransport lookup failed", e);
    }
    return undefined;
  }
  const provider = getMessagingProvider();
  return { provider, sender: envSender(provider.name) };
}

/**
 * Backwards-compatible sender-only lookup. Outbound sends should use
 * `resolveMessagingTransport` so provider and sender cannot be separated.
 */
export async function resolveSender(opts: {
  practiceId?: string;
  locationId?: string;
  hosted?: boolean;
}): Promise<MessagingSender> {
  return (await resolveMessagingTransport(opts))?.sender ?? {};
}
