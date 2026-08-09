import {
  findOwnedPhoneNumbers,
  getA2pBrand,
  getA2pCampaign,
  getA2pNumberAssignment,
  getMessagingProfile,
  messagingProfileSafetyIssues,
  openVpmMessagingProfileName,
} from "@/lib/messaging/telnyx-provisioning";

export interface TelnyxProviderReadinessInput {
  locationId: string;
  messagingProfileId: string;
  senderE164: string;
  providerBrandId: string;
  providerCampaignId: string;
  registrationStatus: string;
  senderRegistrationStatus: string;
  webhookUrl: string;
}

/**
 * Read the exact Telnyx profile, number, carrier registration, and assignment.
 * This helper is deliberately read-only so activation controls and operational
 * monitoring use one definition of provider readiness without changing state.
 */
export async function inspectTelnyxProviderReadiness(
  input: TelnyxProviderReadinessInput,
) {
  const [profile, ownedNumbers, brand, campaign, assignment] =
    await Promise.all([
      getMessagingProfile(input.messagingProfileId),
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
  const ownedNumber = ownedNumbers.length === 1 ? ownedNumbers[0] : undefined;
  if (
    !ownedNumber ||
    ownedNumber.messagingProfileId !== input.messagingProfileId ||
    ownedNumber.status?.toLowerCase() !== "active"
  ) {
    blockers.push("phone number is not active on the exact messaging profile");
  }
  if (
    brand.brandId !== input.providerBrandId ||
    !new Set(["VERIFIED", "VETTED_VERIFIED"]).has(
      (brand.identityStatus ?? "").toUpperCase(),
    )
  ) {
    blockers.push(
      brand.brandId !== input.providerBrandId
        ? "carrier brand identity mismatch"
        : "carrier brand is not verified",
    );
  }
  if (
    campaign.campaignId !== input.providerCampaignId ||
    (campaign.status?.toUpperCase() !== "ACTIVE" &&
      campaign.campaignStatus?.toUpperCase() !== "MNO_PROVISIONED")
  ) {
    blockers.push(
      campaign.campaignId !== input.providerCampaignId
        ? "carrier campaign identity mismatch"
        : "carrier campaign is not active",
    );
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
