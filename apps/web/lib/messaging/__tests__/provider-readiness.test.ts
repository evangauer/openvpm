import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOwnedPhoneNumbers: vi.fn(),
  getA2pBrand: vi.fn(),
  getA2pCampaign: vi.fn(),
  getA2pNumberAssignment: vi.fn(),
  getMessagingProfile: vi.fn(),
  messagingProfileSafetyIssues: vi.fn(),
  openVpmMessagingProfileName: vi.fn(() => "OpenVPM location-1"),
}));

vi.mock("@/lib/messaging/telnyx-provisioning", () => mocks);

const { inspectTelnyxProviderReadiness } =
  await import("@/lib/messaging/provider-readiness");

const input = {
  locationId: "location-1",
  messagingProfileId: "profile-1",
  senderE164: "+15555550100",
  providerBrandId: "brand-1",
  providerCampaignId: "campaign-1",
  registrationStatus: "active",
  senderRegistrationStatus: "active",
  webhookUrl: "https://app.openvpm.com/api/webhooks/telnyx",
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
  mocks.getA2pBrand.mockResolvedValue({
    brandId: "brand-1",
    identityStatus: "VERIFIED",
  });
  mocks.getA2pCampaign.mockResolvedValue({
    campaignId: "campaign-1",
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
    expect(mocks.findOwnedPhoneNumbers).toHaveBeenCalledWith("+15555550100");
    expect(mocks.getA2pBrand).toHaveBeenCalledWith("brand-1");
    expect(mocks.getA2pCampaign).toHaveBeenCalledWith("campaign-1");
    expect(mocks.getA2pNumberAssignment).toHaveBeenCalledWith("+15555550100");
  });

  it("rejects mismatched provider identities even when statuses look active", async () => {
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "different-brand",
      identityStatus: "VERIFIED",
    });
    mocks.getA2pCampaign.mockResolvedValue({
      campaignId: "different-campaign",
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
