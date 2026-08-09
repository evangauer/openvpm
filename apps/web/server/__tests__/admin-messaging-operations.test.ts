import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockTelnyxError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  }
  const selectResults: unknown[][] = [];
  const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const updateReturning = vi.fn(async () => [
    { id: "00000000-0000-0000-0000-000000000009" },
  ]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db = { select, update, execute: vi.fn(async () => undefined) };
  return {
    db,
    selectResults,
    update,
    updateReturning,
    updateSet,
    createA2pBrand: vi.fn(),
    createA2pCampaign: vi.fn(),
    ensureA2pNumberAssignment: vi.fn(),
    findA2pCampaignByReference: vi.fn(),
    findOwnedPhoneNumbers: vi.fn(),
    getA2pBrand: vi.fn(),
    getA2pCampaign: vi.fn(),
    getA2pNumberAssignment: vi.fn(),
    getMessagingProfile: vi.fn(),
    messagingProfileSafetyIssues: vi.fn((): string[] => []),
    openVpmMessagingProfileName: vi.fn(
      (locationId: string) => `OpenVPM provision ${locationId}`,
    ),
    updateMessagingProfileEnabled: vi.fn(),
    MockTelnyxError,
    withTenant: vi.fn(
      async (
        database: unknown,
        _practiceId: string,
        fn: (tx: unknown) => unknown
      ) => fn(database)
    ),
    withSystem: vi.fn(async (database: unknown, fn: (tx: unknown) => unknown) =>
      fn(database)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: mocks.withTenant,
  withSystem: mocks.withSystem,
}));
vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/messaging/telnyx-provisioning", () => ({
  createA2pBrand: mocks.createA2pBrand,
  createA2pCampaign: mocks.createA2pCampaign,
  ensureA2pNumberAssignment: mocks.ensureA2pNumberAssignment,
  findA2pCampaignByReference: mocks.findA2pCampaignByReference,
  findOwnedPhoneNumbers: mocks.findOwnedPhoneNumbers,
  getA2pBrand: mocks.getA2pBrand,
  getA2pCampaign: mocks.getA2pCampaign,
  getA2pNumberAssignment: mocks.getA2pNumberAssignment,
  getMessagingProfile: mocks.getMessagingProfile,
  messagingProfileSafetyIssues: mocks.messagingProfileSafetyIssues,
  openVpmMessagingProfileName: mocks.openVpmMessagingProfileName,
  updateMessagingProfileEnabled: mocks.updateMessagingProfileEnabled,
  TelnyxError: mocks.MockTelnyxError,
}));

const { adminRouter, messagingCampaignCopy } = await import("../routers/admin");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const LOCATION_ID = "00000000-0000-0000-0000-000000000002";
const REGISTRATION_ID = "00000000-0000-0000-0000-000000000008";

function activeRegistration() {
  return {
    id: REGISTRATION_ID,
    practiceId: PRACTICE_ID,
    providerBrandId: "brand-123",
    providerCampaignId: "campaign-123",
    status: "active",
  };
}

function activeSender() {
  return {
    practiceId: PRACTICE_ID,
    locationId: LOCATION_ID,
    provider: "telnyx",
    messagingProfileId: "profile-123",
    senderE164: "+15555550100",
    registrationStatus: "active",
    registrationDetail: null,
    providerProfileReady: false,
    providerProfileSyncedAt: null,
    enabled: false,
  };
}

function providerProfile(enabled: boolean) {
  return {
    id: "profile-123",
    name: `OpenVPM provision ${LOCATION_ID}`,
    webhookUrl: "https://app.openvpm.com/api/webhooks/telnyx",
    webhookApiVersion: "2",
    enabled,
    whitelistedDestinations: ["US"],
    dailySpendLimitEnabled: true,
    dailySpendLimit: "10.00",
    smartEncoding: true,
  };
}

function caller(email = "ops@example.com") {
  return adminRouter.createCaller({
    db: mocks.db,
    session: {
      user: {
        id: USER_ID,
        email,
        name: "Ops",
        role: "admin",
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.updateReturning.mockResolvedValue([
    { id: "00000000-0000-0000-0000-000000000009" },
  ]);
  mocks.selectResults.length = 0;
});

describe("platform messaging operations", () => {
  it("describes the actual clinic-recorded opt-in flow and required disclosures", () => {
    const copy = messagingCampaignCopy({
      displayName: "Healthy Pets",
      businessPhone: "+15555550100",
      website: "https://healthypets.example",
      programUrl:
        "https://app.openvpm.com/sms/00000000-0000-0000-0000-0000000000aa",
      privacyPolicyUrl:
        "https://app.openvpm.com/sms/00000000-0000-0000-0000-0000000000aa/privacy",
      termsUrl:
        "https://app.openvpm.com/sms/00000000-0000-0000-0000-0000000000aa/terms",
      optInUrl:
        "https://app.openvpm.com/sms/00000000-0000-0000-0000-0000000000aa/opt-in",
    });

    expect(copy.messageFlow).toContain("phone or in-person intake");
    expect(copy.messageFlow).toContain("optional and unchecked by default");
    expect(copy.messageFlow).toContain("Consent is not a condition of purchase");
    expect(copy.messageFlow).toContain("/opt-in");
    expect(copy.messageFlow).toContain("/privacy");
    expect(copy.messageFlow).toContain("/terms");
    expect(copy.messageFlow).not.toContain("online booking");
    expect(copy.sample1).toContain("+15555550100");
    expect(copy.sample3).toContain("https://app.openvpm.com/sms/");
    expect(copy.helpMessage).toContain("https://healthypets.example");
    expect(JSON.stringify(copy)).not.toContain("Reply C");
    expect(JSON.stringify(copy)).not.toContain("invoice");
    expect(copy.messageFlow).not.toContain("staff member");
  });

  it("wires stored policies and hosted consent pages into the provider campaign", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    mocks.selectResults.push([
      {
        id: "00000000-0000-0000-0000-000000000008",
        practiceId: PRACTICE_ID,
        providerBrandId: "brand-123",
        providerCampaignId: null,
        displayName: "Healthy Pets",
        businessPhone: "+15555550100",
        website: "https://healthypets.example",
        privacyPolicyUrl: "https://healthypets.example/sms-privacy",
        termsUrl: "https://healthypets.example/sms-terms",
      },
    ]);
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "brand-123",
      identityStatus: "VERIFIED",
    });
    mocks.findA2pCampaignByReference.mockResolvedValue(null);
    mocks.createA2pCampaign.mockResolvedValue({
      campaignId: "campaign-123",
      campaignStatus: "PENDING",
    });

    await expect(
      caller().submitMessagingCampaign({
        practiceId: PRACTICE_ID,
        confirmProviderCharges: true,
        retryAfterProviderReview: false,
      })
    ).resolves.toMatchObject({
      ok: true,
      providerCampaignId: "campaign-123",
      reused: false,
    });

    expect(mocks.createA2pCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: "brand-123",
        referenceId: `openvpm-clinic-${PRACTICE_ID}`,
        privacyPolicyUrl: "https://healthypets.example/sms-privacy",
        termsUrl: "https://healthypets.example/sms-terms",
        sample3: expect.stringContaining(
          `https://app.openvpm.com/sms/${PRACTICE_ID}`
        ),
        messageFlow: expect.stringContaining(
          `https://app.openvpm.com/sms/${PRACTICE_ID}/opt-in`
        ),
        webhookUrl: "https://app.openvpm.com/api/webhooks/telnyx",
      })
    );
    const payload = mocks.createA2pCampaign.mock.calls[0]?.[0];
    expect(payload.messageFlow).toContain(
      "https://healthypets.example/sms-privacy"
    );
    expect(payload.messageFlow).toContain(
      "https://healthypets.example/sms-terms"
    );
  });

  it("blocks fee-bearing provider work before DB reads while the kill-switch is off", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "false");

    await expect(
      caller().submitMessagingBrand({
        practiceId: PRACTICE_ID,
        confirmProviderCharges: true,
        retryAfterProviderReview: false,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.createA2pBrand).not.toHaveBeenCalled();
  });

  it("requires the explicit charge acknowledgement in the validated input", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");

    await expect(
      caller().submitMessagingBrand({
        practiceId: PRACTICE_ID,
        retryAfterProviderReview: false,
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("rejects clinic admins who are not platform operators", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");

    await expect(
      caller("clinic-admin@example.com").submitMessagingBrand({
        practiceId: PRACTICE_ID,
        confirmProviderCharges: true,
        retryAfterProviderReview: false,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.createA2pBrand).not.toHaveBeenCalled();
  });

  it("enables an exact safe provider profile but keeps clinic sending off", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    mocks.selectResults.push(
      [activeSender()],
      [activeRegistration()],
      [activeSender()],
    );
    mocks.getMessagingProfile
      .mockResolvedValueOnce(providerProfile(false))
      .mockResolvedValueOnce(providerProfile(true));
    mocks.findOwnedPhoneNumbers.mockResolvedValue([
      {
        id: "number-123",
        phoneNumber: "+15555550100",
        messagingProfileId: "profile-123",
        status: "active",
      },
    ]);
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "brand-123",
      identityStatus: "VERIFIED",
    });
    mocks.getA2pCampaign.mockResolvedValue({
      campaignId: "campaign-123",
      status: "ACTIVE",
    });
    mocks.getA2pNumberAssignment.mockResolvedValue({
      phoneNumber: "+15555550100",
      campaignId: "campaign-123",
      assignmentStatus: "ASSIGNED",
    });
    mocks.updateMessagingProfileEnabled.mockResolvedValue(
      providerProfile(true),
    );

    await expect(
      caller().setMessagingProfileEnabled({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        enabled: true,
        confirmProviderMutation: true,
      }),
    ).resolves.toEqual({
      locationId: LOCATION_ID,
      enabled: true,
      clinicEnabled: false,
      reused: false,
    });

    expect(mocks.updateMessagingProfileEnabled).toHaveBeenCalledWith({
      profileId: "profile-123",
      enabled: true,
    });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        providerProfileReady: true,
        providerProfileSyncedAt: expect.any(Date),
      }),
    );
    expect(mocks.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("refuses to record readiness when messaging state changes during verification", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    mocks.selectResults.push(
      [activeSender()],
      [activeRegistration()],
      [activeSender()],
    );
    mocks.getMessagingProfile.mockResolvedValue(providerProfile(true));
    mocks.findOwnedPhoneNumbers.mockResolvedValue([
      {
        id: "number-123",
        phoneNumber: "+15555550100",
        messagingProfileId: "profile-123",
        status: "active",
      },
    ]);
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "brand-123",
      identityStatus: "VERIFIED",
    });
    mocks.getA2pCampaign.mockResolvedValue({
      campaignId: "campaign-123",
      status: "ACTIVE",
    });
    mocks.getA2pNumberAssignment.mockResolvedValue({
      phoneNumber: "+15555550100",
      campaignId: "campaign-123",
      assignmentStatus: "ASSIGNED",
    });
    mocks.updateReturning.mockResolvedValueOnce([]);

    await expect(
      caller().setMessagingProfileEnabled({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        enabled: true,
        confirmProviderMutation: true,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("state changed"),
    });

    expect(mocks.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("activates the sender identity returned by the fresh provider inspection", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    const inspectedSender = {
      ...activeSender(),
      messagingProfileId: "profile-current",
      senderE164: "+15555550101",
    };
    mocks.selectResults.push(
      [activeSender()],
      [activeRegistration()],
      [inspectedSender],
    );
    mocks.getMessagingProfile
      .mockResolvedValueOnce({
        ...providerProfile(false),
        id: "profile-current",
      })
      .mockResolvedValueOnce({
        ...providerProfile(true),
        id: "profile-current",
      });
    mocks.findOwnedPhoneNumbers.mockResolvedValue([
      {
        id: "number-123",
        phoneNumber: "+15555550101",
        messagingProfileId: "profile-current",
        status: "active",
      },
    ]);
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "brand-123",
      identityStatus: "VERIFIED",
    });
    mocks.getA2pCampaign.mockResolvedValue({
      campaignId: "campaign-123",
      status: "ACTIVE",
    });
    mocks.getA2pNumberAssignment.mockResolvedValue({
      phoneNumber: "+15555550101",
      campaignId: "campaign-123",
      assignmentStatus: "ASSIGNED",
    });
    mocks.updateMessagingProfileEnabled.mockResolvedValue({
      ...providerProfile(true),
      id: "profile-current",
    });

    await expect(
      caller().setMessagingProfileEnabled({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        enabled: true,
        confirmProviderMutation: true,
      }),
    ).resolves.toMatchObject({ enabled: true, clinicEnabled: false });

    expect(mocks.updateMessagingProfileEnabled).toHaveBeenCalledWith({
      profileId: "profile-current",
      enabled: true,
    });
    expect(mocks.getMessagingProfile).toHaveBeenNthCalledWith(
      2,
      "profile-current",
    );
  });

  it("blocks provider-profile mutations before reads while the kill-switch is off", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "false");

    await expect(
      caller().setMessagingProfileEnabled({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        enabled: true,
        confirmProviderMutation: true,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.updateMessagingProfileEnabled).not.toHaveBeenCalled();
  });

  it("refuses provider activation when exact profile safety checks fail", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    mocks.selectResults.push(
      [activeSender()],
      [activeRegistration()],
      [activeSender()],
    );
    mocks.getMessagingProfile.mockResolvedValue(providerProfile(false));
    mocks.findOwnedPhoneNumbers.mockResolvedValue([
      {
        id: "number-123",
        phoneNumber: "+15555550100",
        messagingProfileId: "profile-123",
        status: "active",
      },
    ]);
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "brand-123",
      identityStatus: "VERIFIED",
    });
    mocks.getA2pCampaign.mockResolvedValue({
      campaignId: "campaign-123",
      status: "ACTIVE",
    });
    mocks.getA2pNumberAssignment.mockResolvedValue({
      phoneNumber: "+15555550100",
      campaignId: "campaign-123",
      assignmentStatus: "ASSIGNED",
    });
    mocks.messagingProfileSafetyIssues.mockReturnValueOnce([
      "webhook URL mismatch",
    ]);

    await expect(
      caller().setMessagingProfileEnabled({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        enabled: true,
        confirmProviderMutation: true,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("webhook URL mismatch"),
    });
    expect(mocks.updateMessagingProfileEnabled).not.toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        providerProfileReady: false,
        providerProfileSyncedAt: null,
      }),
    );
  });

  it("keeps readiness cleared when provider activation readback is unsafe", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    mocks.selectResults.push(
      [activeSender()],
      [activeRegistration()],
      [activeSender()],
    );
    mocks.getMessagingProfile
      .mockResolvedValueOnce(providerProfile(false))
      .mockResolvedValueOnce(providerProfile(true));
    mocks.findOwnedPhoneNumbers.mockResolvedValue([
      {
        id: "number-123",
        phoneNumber: "+15555550100",
        messagingProfileId: "profile-123",
        status: "active",
      },
    ]);
    mocks.getA2pBrand.mockResolvedValue({
      brandId: "brand-123",
      identityStatus: "VERIFIED",
    });
    mocks.getA2pCampaign.mockResolvedValue({
      campaignId: "campaign-123",
      status: "ACTIVE",
    });
    mocks.getA2pNumberAssignment.mockResolvedValue({
      phoneNumber: "+15555550100",
      campaignId: "campaign-123",
      assignmentStatus: "ASSIGNED",
    });
    mocks.messagingProfileSafetyIssues
      .mockReturnValueOnce([])
      .mockReturnValueOnce(["daily spend limit is not enabled"]);

    await expect(
      caller().setMessagingProfileEnabled({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        enabled: true,
        confirmProviderMutation: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        providerProfileReady: false,
        providerProfileSyncedAt: null,
      }),
    );
    expect(mocks.updateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerProfileReady: true }),
    );
  });

  it("turns off the clinic gate before disabling the provider profile", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    mocks.selectResults.push([activeSender()], [activeSender()]);
    mocks.getMessagingProfile
      .mockResolvedValueOnce(providerProfile(true))
      .mockResolvedValueOnce(providerProfile(false));
    mocks.updateMessagingProfileEnabled.mockResolvedValue(
      providerProfile(false),
    );

    await expect(
      caller().setMessagingProfileEnabled({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        enabled: false,
        confirmProviderMutation: true,
      }),
    ).resolves.toMatchObject({ enabled: false, clinicEnabled: false });

    expect(mocks.updateSet.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateMessagingProfileEnabled.mock.invocationCallOrder[0]!,
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        providerProfileReady: false,
      }),
    );
  });

  it("targets the freshly read sender identity during provider deactivation", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    mocks.selectResults.push(
      [activeSender()],
      [
        {
          ...activeSender(),
          messagingProfileId: "profile-current",
          senderE164: "+15555550101",
        },
      ],
    );
    mocks.getMessagingProfile
      .mockResolvedValueOnce({
        ...providerProfile(true),
        id: "profile-current",
      })
      .mockResolvedValueOnce({
        ...providerProfile(false),
        id: "profile-current",
      });
    mocks.updateMessagingProfileEnabled.mockResolvedValue({
      ...providerProfile(false),
      id: "profile-current",
    });

    await expect(
      caller().setMessagingProfileEnabled({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        enabled: false,
        confirmProviderMutation: true,
      }),
    ).resolves.toMatchObject({ enabled: false, clinicEnabled: false });

    expect(mocks.getMessagingProfile).toHaveBeenNthCalledWith(
      1,
      "profile-current",
    );
    expect(mocks.updateMessagingProfileEnabled).toHaveBeenCalledWith({
      profileId: "profile-current",
      enabled: false,
    });
  });

  it("invalidates every sender when recovered provider IDs change", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");

    await expect(
      caller().attachMessagingProviderIds({
        practiceId: PRACTICE_ID,
        providerBrandId: "brand-recovered",
        providerCampaignId: "campaign-recovered",
        confirmProviderPortalReviewed: true,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        providerBrandId: "brand-recovered",
        providerBrandStatus: null,
        providerCampaignId: "campaign-recovered",
        providerCampaignStatus: null,
        status: "pending",
        lastSyncedAt: null,
      }),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        registrationStatus: "pending",
        providerProfileReady: false,
        providerProfileSyncedAt: null,
      }),
    );
  });

  it("clears only a portal-reviewed stale lock and keeps every sender disabled", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.selectResults.push([
      {
        id: "00000000-0000-0000-0000-000000000008",
        submissionLockId: "00000000-0000-0000-0000-000000000007",
        submissionLockAt: new Date(Date.now() - 16 * 60 * 1000),
        providerBrandId: null,
        providerCampaignId: null,
      },
    ]);

    await expect(
      caller().clearStaleMessagingSubmissionLock({
        practiceId: PRACTICE_ID,
        providerObject: "brand",
        confirmProviderPortalReviewed: true,
        confirmNoProviderObjectExists: "NO_PROVIDER_OBJECT",
      })
    ).resolves.toEqual({ ok: true, providerObject: "brand" });

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionLockId: null,
        submissionLockAt: null,
        status: "action_required",
      })
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        registrationStatus: "action_required",
      })
    );
  });

  it("refuses to clear a fresh lock even with the no-object attestation", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.selectResults.push([
      {
        id: "00000000-0000-0000-0000-000000000008",
        submissionLockId: "00000000-0000-0000-0000-000000000007",
        submissionLockAt: new Date(Date.now() - 5 * 60 * 1000),
        providerBrandId: null,
        providerCampaignId: null,
      },
    ]);

    await expect(
      caller().clearStaleMessagingSubmissionLock({
        practiceId: PRACTICE_ID,
        providerObject: "brand",
        confirmProviderPortalReviewed: true,
        confirmNoProviderObjectExists: "NO_PROVIDER_OBJECT",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("15-minute safety window"),
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
