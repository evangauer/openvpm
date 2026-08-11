import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOwnedPhoneNumbers: vi.fn(),
  getA2pBrand: vi.fn(),
  getA2pCampaign: vi.fn(),
  getA2pNumberAssignment: vi.fn(),
  getMessagingProfile: vi.fn(),
  getMessagingProfileAutoresponses: vi.fn(),
  messagingProfileAutoresponseSafetyIssues: vi.fn(),
  messagingProfileSafetyIssues: vi.fn(),
  messagingProfileAutoresponsesForClinic: vi.fn(() => []),
  openVpmMessagingProfileName: vi.fn(() => "OpenVPM location-1"),
}));

vi.mock("@/lib/messaging/telnyx-provisioning", () => mocks);

const { inspectTelnyxProviderReadiness } =
  await import("@/lib/messaging/provider-readiness");

const input = {
  practiceId: "practice-1",
  locationId: "location-1",
  messagingProfileId: "profile-1",
  senderE164: "+15555550100",
  providerBrandId: "brand-1",
  providerCampaignId: "campaign-1",
  registrationStatus: "active",
  senderRegistrationStatus: "active",
  webhookUrl: "https://app.openvpm.com/api/webhooks/telnyx",
  registrationDisplayName: "Healthy Pets",
  registrationEntityType: "PRIVATE_PROFIT",
  registrationBusinessPhone: "+15555550100",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMessagingProfile.mockResolvedValue({
    id: "profile-1",
    enabled: true,
  });
  mocks.findOwnedPhoneNumbers.mockResolvedValue([
    {
      phoneNumber: "+15555550100",
      messagingProfileId: "profile-1",
      status: "active",
    },
  ]);
  mocks.getMessagingProfileAutoresponses.mockResolvedValue([]);
  mocks.messagingProfileAutoresponseSafetyIssues.mockReturnValue([]);
  mocks.getA2pBrand.mockResolvedValue({
    brandId: "brand-1",
    identityStatus: "VERIFIED",
    status: null,
    displayName: "Healthy Pets",
    entityType: "PRIVATE_PROFIT",
    country: "US",
  });
  mocks.getA2pCampaign.mockResolvedValue({
    campaignId: "campaign-1",
    brandId: "brand-1",
    referenceId: "openvpm-clinic-practice-1",
    status: "ACTIVE",
    campaignStatus: null,
  });
  mocks.getA2pNumberAssignment.mockResolvedValue({
    phoneNumber: "+15555550100",
    campaignId: "campaign-1",
    assignmentStatus: "ASSIGNED",
  });
  mocks.messagingProfileSafetyIssues.mockReturnValue([]);
});

describe("Telnyx provider readiness inspection", () => {
  it("reads every exact provider prerequisite without mutating it", async () => {
    await expect(inspectTelnyxProviderReadiness(input)).resolves.toEqual({
      profile: { id: "profile-1", enabled: true },
      blockers: [],
    });
    expect(mocks.getMessagingProfile).toHaveBeenCalledWith("profile-1");
    expect(mocks.getMessagingProfileAutoresponses).toHaveBeenCalledWith(
      "profile-1",
    );
    expect(mocks.findOwnedPhoneNumbers).toHaveBeenCalledWith("+15555550100");
    expect(mocks.getA2pBrand).toHaveBeenCalledWith("brand-1");
    expect(mocks.getA2pCampaign).toHaveBeenCalledWith("campaign-1");
    expect(mocks.getA2pNumberAssignment).toHaveBeenCalledWith("+15555550100");
  });

  it("rejects mismatched provider identities even when statuses look active", async () => {
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "different-brand",
      identityStatus: "VERIFIED",
      displayName: "Healthy Pets",
      entityType: "PRIVATE_PROFIT",
      country: "US",
    });
    mocks.getA2pCampaign.mockResolvedValue({
      campaignId: "different-campaign",
      brandId: "brand-1",
      referenceId: "openvpm-clinic-practice-1",
      status: "ACTIVE",
      campaignStatus: null,
    });

    const result = await inspectTelnyxProviderReadiness(input);

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "carrier brand identity mismatch",
        "carrier campaign identity mismatch",
      ]),
    );
  });

  it("rejects cross-clinic brand/campaign pairing and contradictory terminal state", async () => {
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "brand-1",
      identityStatus: "VERIFIED",
      displayName: "Other Clinic",
      entityType: "PRIVATE_PROFIT",
      country: "US",
    });
    mocks.getA2pCampaign.mockResolvedValue({
      campaignId: "campaign-1",
      brandId: "other-brand",
      referenceId: "openvpm-clinic-other-practice",
      status: "SUSPENDED",
      campaignStatus: "MNO_PROVISIONED",
    });

    const result = await inspectTelnyxProviderReadiness(input);

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "carrier brand registration details mismatch",
        "carrier campaign registration identity mismatch",
      ]),
    );
    expect(result.blockers).toContain("carrier campaign is not active");
  });

  it("rejects a terminal brand status even when identity verification looks active", async () => {
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "brand-1",
      identityStatus: "VERIFIED",
      status: "REGISTRATION_FAILED",
      displayName: "Healthy Pets",
      entityType: "PRIVATE_PROFIT",
      country: "US",
    });

    const result = await inspectTelnyxProviderReadiness(input);

    expect(result.blockers).toContain("carrier brand is not verified");
  });

  it("reports unsafe number, registration, and shared profile checks", async () => {
    mocks.messagingProfileSafetyIssues.mockReturnValue([
      "webhook URL mismatch",
    ]);
    mocks.findOwnedPhoneNumbers.mockResolvedValue([]);

    const result = await inspectTelnyxProviderReadiness({
      ...input,
      registrationStatus: "pending",
    });

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "webhook URL mismatch",
        "phone number is not active on the exact messaging profile",
        "OpenVPM carrier reconciliation is not active",
      ]),
    );
  });

  it("blocks activation when the carrier keyword contract drifts", async () => {
    mocks.messagingProfileAutoresponseSafetyIssues.mockReturnValue([
      "help auto-response is missing or duplicated",
    ]);

    const result = await inspectTelnyxProviderReadiness(input);

    expect(result.blockers).toContain(
      "help auto-response is missing or duplicated",
    );
  });

  it("contains no provider mutation dependency", () => {
    const source = readFileSync(
      new URL("../provider-readiness.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /updateMessagingProfile|createA2p|ensureA2p|buyNumber|deleteOwned/,
    );
  });
});
