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
  const db = { select, update };
  return {
    db,
    selectResults,
    update,
    updateSet,
    createA2pBrand: vi.fn(),
    createA2pCampaign: vi.fn(),
    ensureA2pNumberAssignment: vi.fn(),
    findA2pCampaignByReference: vi.fn(),
    getA2pBrand: vi.fn(),
    getA2pCampaign: vi.fn(),
    getA2pNumberAssignment: vi.fn(),
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
vi.mock("@/lib/messaging/telnyx-provisioning", () => ({
  createA2pBrand: mocks.createA2pBrand,
  createA2pCampaign: mocks.createA2pCampaign,
  ensureA2pNumberAssignment: mocks.ensureA2pNumberAssignment,
  findA2pCampaignByReference: mocks.findA2pCampaignByReference,
  getA2pBrand: mocks.getA2pBrand,
  getA2pCampaign: mocks.getA2pCampaign,
  getA2pNumberAssignment: mocks.getA2pNumberAssignment,
  TelnyxError: mocks.MockTelnyxError,
}));

const { adminRouter, messagingCampaignCopy } = await import("../routers/admin");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

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
