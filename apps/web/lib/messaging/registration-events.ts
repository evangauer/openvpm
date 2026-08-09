import {
  messagingRegistrationEvents,
  messagingRegistrations,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";

export const messagingRegistrationReasonCodes = [
  "clinic_registration_saved",
  "carrier_brand_submission_started",
  "carrier_brand_submitted",
  "carrier_brand_not_verified",
  "carrier_campaign_submission_started",
  "carrier_campaign_recovered",
  "carrier_campaign_submitted",
  "carrier_number_assignment_started",
  "carrier_numbers_assigned",
  "carrier_provider_operation_failed",
  "carrier_registration_reconciled",
  "carrier_webhook_observed",
  "provider_ids_attached_after_portal_review",
  "stale_brand_lock_cleared",
  "stale_campaign_lock_cleared",
  "provider_profile_enabled",
  "provider_profile_disabled",
  "provider_profile_verified",
] as const;

export type MessagingRegistrationReasonCode =
  (typeof messagingRegistrationReasonCodes)[number];

export type MessagingRegistrationEventActor =
  | {
      actorType: "clinic_user";
      actorUserId: string;
      actorIdentity: null;
      actorName: string;
    }
  | {
      actorType: "platform_operator";
      actorUserId: null;
      actorIdentity: string;
      actorName: string;
    }
  | {
      actorType: "system";
      actorUserId: null;
      actorIdentity: null;
      actorName: "OpenVPM system";
    };

export function clinicMessagingRegistrationActor(input: {
  id: string;
  name: string;
}): MessagingRegistrationEventActor {
  return {
    actorType: "clinic_user",
    actorUserId: input.id,
    actorIdentity: null,
    actorName: input.name.trim() || "Clinic admin",
  };
}

function redactedIdentity(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "reviewer-recorded";
  const [local, domain] = normalized.split("@");
  if (!local || !domain) return "reviewer-recorded";
  return `${local.slice(0, 1)}***@${domain}`;
}

export function platformMessagingRegistrationActor(input: {
  email?: string | null;
  name?: string | null;
}): MessagingRegistrationEventActor {
  return {
    actorType: "platform_operator",
    actorUserId: null,
    actorIdentity: redactedIdentity(input.email),
    actorName: input.name?.trim() || "OpenVPM operator",
  };
}

export function systemMessagingRegistrationActor(): MessagingRegistrationEventActor {
  return {
    actorType: "system",
    actorUserId: null,
    actorIdentity: null,
    actorName: "OpenVPM system",
  };
}

type RegistrationProjection = Pick<
  typeof messagingRegistrations.$inferSelect,
  | "id"
  | "practiceId"
  | "provider"
  | "status"
  | "providerBrandId"
  | "providerCampaignId"
  | "providerBrandStatus"
  | "providerCampaignStatus"
>;

export async function recordMessagingRegistrationEvent(
  db: Database,
  input: {
    registration: RegistrationProjection;
    eventType: typeof messagingRegistrationEvents.$inferInsert.eventType;
    operation: typeof messagingRegistrationEvents.$inferInsert.operation;
    statusBefore: typeof messagingRegistrationEvents.$inferInsert.statusBefore;
    operationId: string;
    reasonCode: MessagingRegistrationReasonCode;
    actor: MessagingRegistrationEventActor;
    locationId?: string | null;
    messagingProfileId?: string | null;
  },
) {
  await db.insert(messagingRegistrationEvents).values({
    practiceId: input.registration.practiceId,
    registrationId: input.registration.id,
    locationId: input.locationId ?? null,
    eventType: input.eventType,
    operation: input.operation,
    statusBefore: input.statusBefore ?? null,
    statusAfter: input.registration.status,
    provider: input.registration.provider,
    providerBrandId: input.registration.providerBrandId,
    providerCampaignId: input.registration.providerCampaignId,
    messagingProfileId: input.messagingProfileId ?? null,
    providerBrandStatus: input.registration.providerBrandStatus,
    providerCampaignStatus: input.registration.providerCampaignStatus,
    ...input.actor,
    operationId: input.operationId,
    reasonCode: input.reasonCode,
  });
}
