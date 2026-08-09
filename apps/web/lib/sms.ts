import { recordUsage } from "@/lib/billing/usage";
import { db } from "@openpims/db/client";
import { clients, practices, smsSuppressions } from "@openpims/db";
import { and, eq, isNull } from "drizzle-orm";
import { withSystem } from "@/lib/tenant-db";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import {
  getMessagingProvider,
  normalizeE164,
  resolveMessagingTransport,
  isSuppressed,
  acquireSmsRecipientLockInTransaction,
} from "@/lib/messaging";
import { envFlagEnabled } from "@/lib/env-bool";
import {
  hostedMessagingLaunchBlockMessage,
  hostedMessagingLaunchDecision,
} from "@/lib/messaging/launch-gate";

// ---------------------------------------------------------------------------
// Core send function
//
// Transport is provider-agnostic (lib/messaging): explicit locations bind the
// persisted provider and sender from one active location_messaging row. Calls
// without a location retain the env-selected provider/sender fallback for dev.
// This module keeps the hosted entitlement gate and usage metering.
// ---------------------------------------------------------------------------

export async function sendSms(options: {
  to: string;
  body: string;
  /** When set (and a real send occurs), meters the SMS for hosted billing. */
  practiceId?: string;
  /** Selects the location's bound provider and number/messaging profile. */
  locationId?: string;
  /** Client whose current consent and destination must match immediately before dispatch. */
  clientId?: string;
}): Promise<{ success: boolean; sid?: string; error?: string }> {
  const hostedBilling = billingEnforced();
  const demoMode = envFlagEnabled("NEXT_PUBLIC_DEMO_MODE");
  const hostedExternalSend = hostedBilling && !demoMode;
  const recipient = normalizeE164(options.to);

  if (!recipient) {
    return {
      success: false,
      error:
        "SMS recipient phone number must be a valid E.164 or US/CA number.",
    };
  }

  if (hostedExternalSend) {
    const launch = hostedMessagingLaunchDecision(options);
    if (!launch.allowed) {
      return {
        success: false,
        error: hostedMessagingLaunchBlockMessage(launch.reason),
      };
    }
    if (!options.clientId) {
      return {
        success: false,
        error: "Hosted SMS requires an explicit consented client.",
      };
    }
  }

  // Preserve the locationless hosted guard without consulting the global
  // provider for explicit locations. Their provider comes only from the DB row.
  if (
    !options.locationId &&
    getMessagingProvider().name === "console" &&
    hostedBilling &&
    !demoMode
  ) {
    return {
      success: false,
      error: "SMS provider is not configured for hosted sending.",
    };
  }

  if (options.practiceId && hostedBilling) {
    const [practice] = await withSystem(db, (tx) =>
      tx
        .select({
          tier: practices.subscriptionTier,
          billingStatus: practices.billingStatus,
          trialEndsAt: practices.trialEndsAt,
        })
        .from(practices)
        .where(
          and(
            eq(practices.id, options.practiceId!),
            isNull(practices.deletedAt)
          )
        )
        .limit(1)
    );
    if (!practice) {
      return { success: false, error: "Practice not found" };
    }
    if (
      !hasHostedFullAccess(
        practice.tier,
        practice.billingStatus,
        practice.trialEndsAt
      )
    ) {
      return {
        success: false,
        error:
          "OpenVPM Cloud is read-only until your trial or subscription is active.",
      };
    }
  }

  // Hard opt-out gate: never text a number on the practice's suppression list.
  // Fail closed — if we can't verify opt-out status, block rather than risk it.
  // Hosted dispatch repeats this check under a per-recipient transaction lock
  // immediately before the provider call, so stale automation snapshots cannot
  // outrun a concurrent STOP/manual revoke.
  if (options.practiceId && !hostedExternalSend) {
    try {
      if (await isSuppressed(options.practiceId, recipient)) {
        return {
          success: false,
          error: "Recipient has opted out of SMS (STOP).",
        };
      }
    } catch {
      return {
        success: false,
        error: "Could not verify SMS opt-out status; send blocked.",
      };
    }
  }

  const transport = await resolveMessagingTransport({
    practiceId: options.practiceId,
    locationId: options.locationId,
    hosted: hostedExternalSend,
  });
  if (options.locationId && !transport) {
    return {
      success: false,
      error: "No active texting sender is configured for this location.",
    };
  }

  if (!transport) {
    return { success: false, error: "SMS provider is not configured." };
  }

  const { provider, sender } = transport;
  if (hostedExternalSend && provider.name !== "telnyx") {
    return {
      success: false,
      error:
        "Hosted texting is available only through the approved Telnyx pilot.",
    };
  }
  if (provider.name === "console" && hostedBilling && !demoMode) {
    return {
      success: false,
      error: "SMS provider is not configured for hosted sending.",
    };
  }

  const result = hostedExternalSend
    ? await withSystem(db, async (tx) => {
        try {
          const practiceId = options.practiceId!;
          const clientId = options.clientId!;
          await acquireSmsRecipientLockInTransaction(tx, practiceId, recipient);

          const [client] = await tx
            .select({
              phone: clients.phone,
              smsConsent: clients.smsConsent,
              smsConsentAt: clients.smsConsentAt,
              smsConsentSource: clients.smsConsentSource,
              smsConsentDisclosure: clients.smsConsentDisclosure,
            })
            .from(clients)
            .where(
              and(
                eq(clients.id, clientId),
                eq(clients.practiceId, practiceId),
                isNull(clients.deletedAt)
              )
            )
            .limit(1)
            .for("share");
          if (
            !client?.smsConsent ||
            !client.smsConsentAt ||
            !client.smsConsentSource?.trim() ||
            !client.smsConsentDisclosure?.trim() ||
            normalizeE164(client.phone) !== recipient
          ) {
            return {
              success: false,
              error:
                "Client SMS consent or phone changed before sending; delivery was blocked.",
            };
          }

          const [suppression] = await tx
            .select({ id: smsSuppressions.id })
            .from(smsSuppressions)
            .where(
              and(
                eq(smsSuppressions.practiceId, practiceId),
                eq(smsSuppressions.phone, recipient)
              )
            )
            .limit(1);
          if (suppression) {
            return {
              success: false,
              error: "Recipient has opted out of SMS (STOP).",
            };
          }

          return provider.send({
            to: recipient,
            body: options.body,
            sender,
          });
        } catch (error) {
          console.error("[messaging] hosted dispatch preflight failed", error);
          return {
            success: false,
            error: "Could not verify SMS consent; send blocked.",
          };
        }
      })
    : await provider.send({
        to: recipient,
        body: options.body,
        sender,
      });

  // Meter only real sends (not the dev-console fallback); no-op on self-host.
  if (result.success && provider.name !== "console" && options.practiceId) {
    await recordUsage({ practiceId: options.practiceId, kind: "sms" });
  }

  return { success: result.success, sid: result.id, error: result.error };
}

// ---------------------------------------------------------------------------
// Appointment reminder SMS
// ---------------------------------------------------------------------------

export async function sendAppointmentReminderSms(data: {
  to: string;
  patientName: string;
  appointmentDate: string;
  appointmentTime: string;
  practiceName: string;
  practicePhone?: string;
  practiceId?: string;
  locationId?: string;
  clientId?: string;
}): Promise<{ success: boolean; sid?: string; error?: string }> {
  const phoneInfo = data.practicePhone
    ? `Call ${data.practicePhone} to reschedule.`
    : "Contact us to reschedule.";

  const body = `Hi! Reminder: ${data.patientName} has an appointment on ${data.appointmentDate} at ${data.appointmentTime}. ${phoneInfo} - ${data.practiceName}`;

  const result = await sendSms({
    to: data.to,
    body,
    practiceId: data.practiceId,
    locationId: data.locationId,
    clientId: data.clientId,
  });
  return { success: result.success, sid: result.sid, error: result.error };
}

// ---------------------------------------------------------------------------
// Vaccination reminder SMS
// ---------------------------------------------------------------------------

export async function sendVaccinationReminderSms(data: {
  to: string;
  patientName: string;
  vaccineName: string;
  practiceName: string;
  practicePhone?: string;
  practiceId?: string;
  locationId?: string;
  clientId?: string;
}): Promise<{ success: boolean; sid?: string; error?: string }> {
  const phoneInfo = data.practicePhone
    ? `Call ${data.practicePhone} to schedule.`
    : "Contact us to schedule.";

  const body = `Hi! ${data.patientName} is due for their ${data.vaccineName} vaccination. ${phoneInfo} - ${data.practiceName}`;

  const result = await sendSms({
    to: data.to,
    body,
    practiceId: data.practiceId,
    locationId: data.locationId,
    clientId: data.clientId,
  });
  return { success: result.success, sid: result.sid, error: result.error };
}
