import { recordUsage } from "@/lib/billing/usage";
import { db } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { and, eq, isNull } from "drizzle-orm";
import { withSystem } from "@/lib/tenant-db";
import { billingEnforced, hasHostedFullAccess } from "@/lib/billing/plans";
import {
  getMessagingProvider,
  normalizeE164,
  resolveSender,
  isSuppressed,
} from "@/lib/messaging";
import { envFlagEnabled } from "@/lib/env-bool";

// ---------------------------------------------------------------------------
// Core send function
//
// Transport is provider-agnostic (lib/messaging): the active provider (Telnyx
// preferred, Twilio fallback, console in dev) is chosen by env. This module
// keeps the hosted entitlement gate and usage metering; the per-location sender
// is resolved by lib/messaging (env default today, per-location config in P1).
// ---------------------------------------------------------------------------

export async function sendSms(options: {
  to: string;
  body: string;
  /** When set (and a real send occurs), meters the SMS for hosted billing. */
  practiceId?: string;
  /** Future: selects the location's own number/messaging profile (P1). */
  locationId?: string;
}): Promise<{ success: boolean; sid?: string; error?: string }> {
  const provider = getMessagingProvider();
  const hostedBilling = billingEnforced();
  const recipient = normalizeE164(options.to);

  if (!recipient) {
    return {
      success: false,
      error: "SMS recipient phone number must be a valid E.164 or US/CA number.",
    };
  }

  if (
    provider.name === "console" &&
    hostedBilling &&
    !envFlagEnabled("NEXT_PUBLIC_DEMO_MODE")
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
  if (options.practiceId) {
    try {
      if (await isSuppressed(options.practiceId, recipient)) {
        return { success: false, error: "Recipient has opted out of SMS (STOP)." };
      }
    } catch {
      return {
        success: false,
        error: "Could not verify SMS opt-out status; send blocked.",
      };
    }
  }

  const sender = await resolveSender({
    practiceId: options.practiceId,
    locationId: options.locationId,
  });
  if (
    options.locationId &&
    !sender.messagingServiceId &&
    !sender.from
  ) {
    return {
      success: false,
      error: "No active texting sender is configured for this location.",
    };
  }

  const result = await provider.send({
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
  });
  return { success: result.success, sid: result.sid, error: result.error };
}
