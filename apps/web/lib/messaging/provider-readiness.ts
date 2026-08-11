import {
  findOwnedPhoneNumbers,
  getA2pBrand,
  getA2pCampaign,
  getA2pNumberAssignment,
  getMessagingProfile,
  getMessagingProfileAutoresponses,
  messagingProfileAutoresponseSafetyIssues,
  messagingProfileAutoresponsesForClinic,
  messagingProfileSafetyIssues,
  openVpmMessagingProfileName,
} from "@/lib/messaging/telnyx-provisioning";
import { telnyxCampaignIsActive } from "@/lib/messaging/a2p-lifecycle";

export interface TelnyxProviderReadinessInput {
  practiceId: string;
  locationId: string;
  messagingProfileId: string;
  senderE164: string;
  providerBrandId: string;
  providerCampaignId: string;
  registrationStatus: string;
  senderRegistrationStatus: string;
  webhookUrl: string;
  registrationDisplayName: string;
  registrationEntityType: string;
  registrationBusinessPhone: string;
  requireAutoresponses?: boolean;
}

/**
 * Read the exact Telnyx profile, number, carrier registration, and assignment.
 * This helper is deliberately read-only so activation controls and operational
 * monitoring use one definition of provider readiness without changing state.
 */
export async function inspectTelnyxProviderReadiness(
  input: TelnyxProviderReadinessInput,
) {
  const [profile, autoresponses, ownedNumbers, brand, campaign, assignment] =
    await Promise.all([
      getMessagingProfile(input.messagingProfileId),
      getMessagingProfileAutoresponses(input.messagingProfileId),
      findOwnedPhoneNumbers(input.senderE164),
      getA2pBrand(input.providerBrandId),
      getA2pCampaign(input.providerCampaignId),
      getA2pNumberAssignment(input.senderE164),
    ]);

  const blockers = messagingProfileSafetyIssues(profile, {
    id: input.messagingProfileId,
    name: openVpmMessagingProfileName(input.locationId),
    webhookUrl: input.webhookUrl,
  });
  if (input.requireAutoresponses !== false) {
    blockers.push(
      ...messagingProfileAutoresponseSafetyIssues(
        autoresponses,
        messagingProfileAutoresponsesForClinic({
          displayName: input.registrationDisplayName,
          businessPhone: input.registrationBusinessPhone,
        }),
      ),
    );
  }
  const ownedNumber = ownedNumbers.length === 1 ? ownedNumbers[0] : undefined;
  if (
    !ownedNumber ||
    ownedNumber.messagingProfileId !== input.messagingProfileId ||
    ownedNumber.status?.toLowerCase() !== "active"
  ) {
    blockers.push("phone number is not active on the exact messaging profile");
  }
  if (brand.brandId !== input.providerBrandId) {
    blockers.push("carrier brand identity mismatch");
  }
  if (
    (brand.displayName !== undefined &&
      brand.displayName !== input.registrationDisplayName) ||
    (brand.entityType !== undefined &&
      brand.entityType !== input.registrationEntityType) ||
    (brand.country !== undefined && brand.country !== "US")
  ) {
    blockers.push("carrier brand registration details mismatch");
  }
  if (
    !new Set(["VERIFIED", "VETTED_VERIFIED"]).has(
      (brand.identityStatus ?? "").toUpperCase(),
    ) ||
    (brand.status !== undefined &&
      brand.status !== null &&
      brand.status.toUpperCase() !== "OK")
  ) {
    blockers.push("carrier brand is not verified");
  }
  if (campaign.campaignId !== input.providerCampaignId) {
    blockers.push("carrier campaign identity mismatch");
  }
  if (
    (campaign.brandId !== undefined &&
      campaign.brandId !== input.providerBrandId) ||
    (campaign.referenceId !== undefined &&
      campaign.referenceId !== `openvpm-clinic-${input.practiceId}`)
  ) {
    blockers.push("carrier campaign registration identity mismatch");
  }
  if (!telnyxCampaignIsActive(campaign)) {
    blockers.push("carrier campaign is not active");
  }
  if (
    !assignment ||
    assignment.phoneNumber !== input.senderE164 ||
    assignment.campaignId !== input.providerCampaignId ||
    assignment.assignmentStatus?.toUpperCase() !== "ASSIGNED"
  ) {
    blockers.push("phone number is not assigned to the active campaign");
  }
  if (
    input.registrationStatus !== "active" ||
    input.senderRegistrationStatus !== "active"
  ) {
    blockers.push("OpenVPM carrier reconciliation is not active");
  }

  return { profile, blockers };
}
