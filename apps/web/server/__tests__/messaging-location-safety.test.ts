import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockTelnyxNotConfiguredError extends Error {}
  class MockTelnyxError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  }
  class MockTelnyxMutationUncertainError extends Error {}
  return {
    sendSms: vi.fn(),
    searchAvailableNumbers: vi.fn(),
    findAvailableNumberQuotes: vi.fn(),
    createMessagingProfile: vi.fn(),
    buyNumber: vi.fn(),
    deleteMessagingProfile: vi.fn(),
    deleteOwnedPhoneNumber: vi.fn(),
    findMessagingProfilesByName: vi.fn(),
    findOwnedPhoneNumbers: vi.fn(),
    findNumberOrdersByCustomerReference: vi.fn(),
    reserveMessagingProfileAttempt: vi.fn(),
    releaseMessagingProfileAttempt: vi.fn(),
    TelnyxError: MockTelnyxError,
    TelnyxMutationUncertainError: MockTelnyxMutationUncertainError,
    TelnyxNotConfiguredError: MockTelnyxNotConfiguredError,
    usageForPractice: vi.fn(async () => 0),
    currentPeriodMonth: vi.fn(() => "2026-06"),
  };
});

vi.mock("@/lib/sms", () => ({
  sendSms: mocks.sendSms,
}));

vi.mock("@/lib/messaging/telnyx-provisioning", () => ({
  searchAvailableNumbers: mocks.searchAvailableNumbers,
  findAvailableNumberQuotes: mocks.findAvailableNumberQuotes,
  createMessagingProfile: mocks.createMessagingProfile,
  buyNumber: mocks.buyNumber,
  deleteMessagingProfile: mocks.deleteMessagingProfile,
  deleteOwnedPhoneNumber: mocks.deleteOwnedPhoneNumber,
  findMessagingProfilesByName: mocks.findMessagingProfilesByName,
  findOwnedPhoneNumbers: mocks.findOwnedPhoneNumbers,
  findNumberOrdersByCustomerReference:
    mocks.findNumberOrdersByCustomerReference,
  TelnyxError: mocks.TelnyxError,
  TelnyxMutationUncertainError: mocks.TelnyxMutationUncertainError,
  TelnyxNotConfiguredError: mocks.TelnyxNotConfiguredError,
}));

vi.mock("@/lib/messaging/provisioning-attempt-gate", () => ({
  reserveMessagingProfileAttempt: mocks.reserveMessagingProfileAttempt,
  releaseMessagingProfileAttempt: mocks.releaseMessagingProfileAttempt,
}));

vi.mock("@/lib/billing/usage", () => ({
  usageForPractice: mocks.usageForPractice,
  currentPeriodMonth: mocks.currentPeriodMonth,
}));

const { messagingRouter } = await import("../routers/messaging");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const LOCATION_ID = "00000000-0000-0000-0000-000000000002";
const SELECTED_QUOTE = {
  upfrontCost: "3.21",
  monthlyCost: "6.54",
  currency: "USD",
} as const;

function startNumberInput() {
  return {
    locationId: LOCATION_ID,
    mode: "buy" as const,
    action: "start" as const,
    phoneNumber: "+15555550100",
    quote: SELECTED_QUOTE,
    confirmProviderCharges: true as const,
  };
}

function resumeNumberInput() {
  return {
    locationId: LOCATION_ID,
    mode: "buy" as const,
    action: "resume" as const,
  };
}

function preparedMessagingGate() {
  return {
    provider: "telnyx",
    messagingProfileId: null,
    senderE164: "+15555550100",
    numberSource: "purchased",
    registrationStatus: "failed",
  };
}

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      practiceId: PRACTICE_ID,
    },
  };
  return messagingRouter.createCaller({ db, session } as never);
}

function sqlIncludesColumnParamPair(
  value: unknown,
  columnName: string,
  paramValue: unknown
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const chunk = value as { name?: unknown; queryChunks?: unknown[] };
  if (!Array.isArray(chunk.queryChunks)) {
    return false;
  }

  const hasColumn = chunk.queryChunks.some(
    (item) =>
      !!item &&
      typeof item === "object" &&
      (item as { name?: unknown }).name === columnName
  );
  const hasParam = chunk.queryChunks.some((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const candidate = item as { value?: unknown };
    return Object.prototype.hasOwnProperty.call(candidate, "value")
      ? Object.is(candidate.value, paramValue)
      : false;
  });

  return (
    (hasColumn && hasParam) ||
    chunk.queryChunks.some((item) =>
      sqlIncludesColumnParamPair(item, columnName, paramValue)
    )
  );
}

function createDb(opts?: {
  selectResults?: unknown[][];
  practiceRows?: unknown[];
  updateRows?: unknown[];
}) {
  const selectResults = [
    opts?.practiceRows ?? [{ id: PRACTICE_ID }],
    ...(opts?.selectResults ?? []),
  ];
  const nextSelectRows = () => selectResults.shift() ?? [];
  const selectLimit = vi.fn(async () => nextSelectRows());
  const selectWhere = vi.fn(() => ({
    limit: selectLimit,
    then: (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(nextSelectRows()).then(resolve, reject),
  }));
  const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
  const selectFrom = vi.fn(() => ({
    innerJoin: selectInnerJoin,
    leftJoin: selectInnerJoin,
    where: selectWhere,
  }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateReturning = vi.fn(async () => opts?.updateRows ?? []);
  const updateWhere = vi.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const insertUpdate = vi.fn(async (_config: unknown) => undefined);
  const insertValues = vi.fn((_values: unknown) => ({
    onConflictDoUpdate: insertUpdate,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const execute = vi.fn(async () => undefined);
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute,
    select,
    update,
    insert,
  };

  return {
    db,
    select,
    execute,
    updateSet,
    updateWhere,
    insertValues,
    insertUpdate,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMessagingProfilesByName.mockResolvedValue([]);
  mocks.findOwnedPhoneNumbers.mockResolvedValue([]);
  mocks.findNumberOrdersByCustomerReference.mockResolvedValue([]);
  mocks.findAvailableNumberQuotes.mockResolvedValue([
    { phoneNumber: "+15555550100", ...SELECTED_QUOTE },
  ]);
  mocks.reserveMessagingProfileAttempt.mockResolvedValue(true);
  mocks.releaseMessagingProfileAttempt.mockResolvedValue(true);
  mocks.createMessagingProfile.mockResolvedValue({ id: "profile_123" });
  mocks.buyNumber.mockResolvedValue({
    orderId: "order_123",
    status: "pending",
  });
  mocks.deleteMessagingProfile.mockResolvedValue(undefined);
  mocks.deleteOwnedPhoneNumber.mockResolvedValue(undefined);
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXTAUTH_URL;
  delete process.env.HOSTED_BILLING_ENABLED;
  delete process.env.MESSAGING_PROVISIONING_PRACTICE_IDS;
  delete process.env.MESSAGING_SENDING_ENABLED;
  delete process.env.MESSAGING_SENDING_PRACTICE_IDS;
  delete process.env.MESSAGING_SENDING_LOCATION_IDS;
  // The platform kill-switch is on for behavior tests; the gate itself is
  // covered in "messaging provisioning kill-switch".
  vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("messaging provisioning kill-switch", () => {
  it("blocks number search and provisioning until ops enables it", async () => {
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "");
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("almost ready"),
    });
    await expect(
      callerWithDb(db).searchNumbers({ areaCode: "212" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // No DB reads and no Telnyx calls happen while the switch is off.
    expect(select).not.toHaveBeenCalled();
    expect(mocks.searchAvailableNumbers).not.toHaveBeenCalled();
  });

  it("requires an explicit practice allowlist for hosted number orders", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    const { db, select } = createDb({
      practiceRows: [
        {
          tier: "cloud",
          billingStatus: "trialing",
          trialEndsAt: new Date("2099-01-01T00:00:00Z"),
        },
      ],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("approved pilot clinics"),
    });

    // Only the hosted subscription guard may read; the messaging mutation
    // stops before its practice/location queries or any provider call.
    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });
});

describe("messaging location target safety", () => {
  it("prefills carrier registration from the active clinic without exposing legal fields", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    const { db } = createDb({
      selectResults: [
        [
          {
            name: "Healthy Pets",
            email: null,
            phone: null,
            website: "https://example.com",
            primaryLocationPhone: "+15555550100",
          },
        ],
      ],
    });

    await expect(callerWithDb(db).getRegistrationDefaults()).resolves.toEqual({
      displayName: "Healthy Pets",
      contactFirstName: "Admin",
      contactLastName: "",
      contactEmail: "admin@example.com",
      businessPhone: "+15555550100",
      website: "https://example.com",
      programUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}`,
      privacyPolicyUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/privacy`,
      termsUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/terms`,
      optInUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/opt-in`,
    });
  });

  it("leaves invalid or overlong clinic defaults blank instead of creating save errors", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    const { db } = createDb({
      selectResults: [
        [
          {
            name: "x".repeat(101),
            email: "x".repeat(101) + "@example.com",
            phone: "not-a-phone",
            website: "https://example.com/" + "x".repeat(101),
            primaryLocationPhone: null,
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).getRegistrationDefaults()
    ).resolves.toMatchObject({
      displayName: "",
      contactEmail: "admin@example.com",
      businessPhone: "",
      website: "",
    });
  });

  it("keeps carrier registration available when the clinic website is blank", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    const { db } = createDb({
      selectResults: [
        [
          {
            name: "Healthy Pets",
            email: "clinic@example.com",
            phone: "+15555550100",
            website: "",
            primaryLocationPhone: null,
          },
        ],
      ],
    });

    await expect(callerWithDb(db).getRegistrationDefaults()).resolves.toEqual({
      displayName: "Healthy Pets",
      contactFirstName: "Admin",
      contactLastName: "",
      contactEmail: "clinic@example.com",
      businessPhone: "+15555550100",
      website: "",
      programUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}`,
      privacyPolicyUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/privacy`,
      termsUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/terms`,
      optInUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/opt-in`,
    });
  });

  it("encrypts clinic tax IDs and upserts registration details tenant-scoped", async () => {
    vi.stubEnv(
      "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
      Buffer.alloc(32, 9).toString("base64")
    );
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).saveRegistration({
        entityType: "PRIVATE_PROFIT",
        displayName: "Healthy Pets",
        legalName: "Healthy Pets LLC",
        taxId: "12-3456789",
        contactFirstName: "Alex",
        contactLastName: "Vet",
        contactEmail: "alex@example.com",
        businessPhone: "+15555550100",
        street: "1 Main St",
        city: "Denver",
        state: "co",
        postalCode: "80202",
        website: "https://example.com",
        privacyPolicyUrl: "https://example.com/privacy",
        termsUrl: "https://example.com/terms",
        certifyAccuracyAndConsent: true,
      })
    ).resolves.toEqual({ ok: true, taxIdLast4: "6789" });

    const values = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      practiceId: PRACTICE_ID,
      businessPhone: "+15555550100",
      state: "CO",
      taxIdLast4: "6789",
      status: "not_started",
      complianceAttestedBy: USER_ID,
    });
    expect(values.taxIdEncrypted).toMatch(/^v1:/);
    expect(JSON.stringify(values)).not.toContain("123456789");
  });

  it("uses the hosted clinic SMS policies when custom links are omitted", async () => {
    vi.stubEnv(
      "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
      Buffer.alloc(32, 9).toString("base64")
    );
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.openvpm.com");
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await callerWithDb(db).saveRegistration({
      entityType: "PRIVATE_PROFIT",
      displayName: "Healthy Pets",
      legalName: "Healthy Pets LLC",
      taxId: "12-3456789",
      contactFirstName: "Alex",
      contactLastName: "Vet",
      contactEmail: "alex@example.com",
      businessPhone: "+15555550100",
      street: "1 Main St",
      city: "Denver",
      state: "CO",
      postalCode: "80202",
      website: "https://example.com",
      certifyAccuracyAndConsent: true,
    });

    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({
      privacyPolicyUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/privacy`,
      termsUrl: `https://app.openvpm.com/sms/${PRACTICE_ID}/terms`,
    });
  });

  it("rejects invalid messaging phone inputs before DB or provider calls", async () => {
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).provisionNumber({
        ...startNumberInput(),
        phoneNumber: "12345",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).testSend({
        locationId: LOCATION_ID,
        to: "1".repeat(33),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("rejects messaging reads and provider actions when the practice is missing or deleted", async () => {
    const { db, updateSet, insertValues } = createDb({ practiceRows: [] });
    const caller = callerWithDb(db);

    await expect(caller.getInboxStatus()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.getStatus()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.searchNumbers({ areaCode: "212" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      caller.provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(mocks.searchAvailableNumbers).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects status when the practice disappears before plan tier lookup", async () => {
    const { db } = createDb({
      selectResults: [[], []],
    });

    await expect(callerWithDb(db).getStatus()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(mocks.usageForPractice).toHaveBeenCalledWith(
      PRACTICE_ID,
      "sms",
      "2026-06"
    );
  });

  it("rejects eligibility checks for stale or deleted locations", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).checkEligibility({ locationId: LOCATION_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.findMessagingProfilesByName).not.toHaveBeenCalled();
  });

  it("reports existing-number hosting as unavailable without contacting a provider", async () => {
    const { db } = createDb({
      selectResults: [[{ phone: "+15555550100" }]],
    });

    await expect(
      callerWithDb(db).checkEligibility({ locationId: LOCATION_ID })
    ).resolves.toEqual({
      eligible: false,
      detail: expect.stringContaining("has not ported or changed"),
    });

    expect(mocks.findMessagingProfilesByName).not.toHaveBeenCalled();
    expect(mocks.findOwnedPhoneNumbers).not.toHaveBeenCalled();
  });

  it("truthfully rejects existing-number hosting without provider mutation", async () => {
    const { db } = createDb();

    await expect(
      callerWithDb(db).provisionNumber({
        locationId: LOCATION_ID,
        mode: "host",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("has not ported or changed"),
    });

    expect(mocks.findMessagingProfilesByName).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("rejects provisioning stale or deleted locations before provider calls", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const { db } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("requires a public HTTPS app URL before provisioning provider webhooks", async () => {
    const missingEnv = createDb({
      selectResults: [
        [{ id: LOCATION_ID, name: "Main Clinic", phone: "(555) 555-0100" }],
      ],
    });

    await expect(
      callerWithDb(missingEnv.db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Set NEXT_PUBLIC_APP_URL or NEXTAUTH_URL to your public HTTPS app URL before provisioning texting.",
    });

    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    const localEnv = createDb({
      selectResults: [
        [{ id: LOCATION_ID, name: "Main Clinic", phone: "(555) 555-0100" }],
      ],
    });

    await expect(
      callerWithDb(localEnv.db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("never calls the provider when a fresh durable attempt cannot be reserved", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.reserveMessagingProfileAttempt.mockResolvedValueOnce(false);
    const { db } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("could not reserve"),
    });
    expect(mocks.findMessagingProfilesByName).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("falls back to NEXTAUTH_URL when NEXT_PUBLIC_APP_URL is blank", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "   ";
    process.env.NEXTAUTH_URL = "https://auth.example.com/settings";
    const { db } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).resolves.toMatchObject({
      ok: true,
      senderE164: "+15555550100",
      numberSource: "purchased",
    });

    expect(mocks.createMessagingProfile).toHaveBeenCalledWith({
      name: `OpenVPM provision ${LOCATION_ID}`,
      webhookUrl: "https://auth.example.com/api/webhooks/telnyx",
    });
    expect(mocks.buyNumber).toHaveBeenCalledWith({
      phoneNumber: "+15555550100",
      messagingProfileId: "profile_123",
      customerReference: `openvpm:${PRACTICE_ID}:${LOCATION_ID}`,
    });
  });

  it("passes the public Telnyx webhook URL and reactivates sender rows", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const { db, insertValues, insertUpdate } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).resolves.toEqual({
      ok: true,
      senderE164: "+15555550100",
      numberSource: "purchased",
      recovered: false,
    });

    expect(mocks.createMessagingProfile).toHaveBeenCalledWith({
      name: `OpenVPM provision ${LOCATION_ID}`,
      webhookUrl: "https://app.example.com/api/webhooks/telnyx",
    });
    expect(mocks.buyNumber).toHaveBeenCalledWith({
      phoneNumber: "+15555550100",
      messagingProfileId: "profile_123",
      customerReference: `openvpm:${PRACTICE_ID}:${LOCATION_ID}`,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        messagingProfileId: "profile_123",
        senderE164: "+15555550100",
        registrationStatus: "not_started",
        registrationDetail: expect.stringContaining("Number order accepted"),
        enabled: false,
      })
    );
    expect(insertUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          messagingProfileId: "profile_123",
          senderE164: "+15555550100",
          registrationStatus: "not_started",
          registrationDetail: expect.stringContaining("Number order accepted"),
          enabled: false,
          deletedAt: null,
          updatedAt: expect.any(Date),
        }),
      })
    );
  });

  it("returns an existing completed operation without another provider call", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const { db } = createDb({
      selectResults: [
        [{ id: LOCATION_ID }],
        [
          {
            provider: "telnyx",
            messagingProfileId: "profile_123",
            senderE164: "+15555550100",
            numberSource: "purchased",
            registrationStatus: "not_started",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).resolves.toEqual({
      ok: true,
      senderE164: "+15555550100",
      numberSource: "purchased",
      recovered: true,
    });

    expect(mocks.findMessagingProfilesByName).not.toHaveBeenCalled();
    expect(mocks.findOwnedPhoneNumbers).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("reconciles an interrupted purchase without buying the number twice", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.findMessagingProfilesByName.mockResolvedValue([
      {
        id: "profile_123",
        name: `OpenVPM provision ${LOCATION_ID}`,
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        enabled: false,
      },
    ]);
    mocks.findOwnedPhoneNumbers.mockResolvedValue([
      {
        id: "number_123",
        phoneNumber: "+15555550100",
        messagingProfileId: "profile_123",
        status: "active",
      },
    ]);
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: LOCATION_ID }],
        [
          {
            provider: "telnyx",
            messagingProfileId: "profile_123",
            senderE164: "+15555550100",
            numberSource: "purchased",
            registrationStatus: "failed",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).provisionNumber(resumeNumberInput())
    ).resolves.toMatchObject({ recovered: true, numberSource: "purchased" });

    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationStatus: "not_started",
        enabled: false,
      })
    );
  });

  it("recovers a pending exact customer-reference order before phone inventory appears", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.findMessagingProfilesByName.mockResolvedValue([
      {
        id: "profile_123",
        name: `OpenVPM provision ${LOCATION_ID}`,
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        enabled: false,
      },
    ]);
    mocks.findNumberOrdersByCustomerReference.mockResolvedValue([
      {
        id: "order_123",
        status: "pending",
        customerReference: `openvpm:${PRACTICE_ID}:${LOCATION_ID}`,
        messagingProfileId: "profile_123",
        phoneNumbers: ["+15555550100"],
      },
    ]);
    const { db, insertValues } = createDb({
      selectResults: [
        [{ id: LOCATION_ID }],
        [
          {
            provider: "telnyx",
            messagingProfileId: "profile_123",
            senderE164: "+15555550100",
            numberSource: "purchased",
            registrationStatus: "failed",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).provisionNumber(resumeNumberInput())
    ).resolves.toMatchObject({ recovered: true, senderE164: "+15555550100" });

    expect(mocks.buyNumber).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        messagingProfileId: "profile_123",
        senderE164: "+15555550100",
        registrationStatus: "not_started",
      })
    );
  });

  it.each([
    "transport timeout",
    "HTTP 408",
    "HTTP 429",
    "HTTP 500",
    "malformed successful response",
  ])("never issues a second order POST after %s", async (scenario) => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.findMessagingProfilesByName
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "profile_123",
          name: `OpenVPM provision ${LOCATION_ID}`,
          webhookUrl: "https://app.example.com/api/webhooks/telnyx",
          enabled: false,
        },
      ]);
    mocks.findNumberOrdersByCustomerReference
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "order_123",
          status: "pending",
          customerReference: `openvpm:${PRACTICE_ID}:${LOCATION_ID}`,
          messagingProfileId: "profile_123",
          phoneNumbers: ["+15555550100"],
        },
      ]);
    mocks.buyNumber.mockRejectedValueOnce(
      new mocks.TelnyxMutationUncertainError(`${scenario}: reconcile required`)
    );

    const first = createDb({ selectResults: [[{ id: LOCATION_ID }], []] });
    await expect(
      callerWithDb(first.db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    const retry = createDb({
      selectResults: [
        [{ id: LOCATION_ID }],
        [
          {
            provider: "telnyx",
            messagingProfileId: "profile_123",
            senderE164: "+15555550100",
            numberSource: "purchased",
            registrationStatus: "failed",
          },
        ],
      ],
    });
    await expect(
      callerWithDb(retry.db).provisionNumber(resumeNumberInput())
    ).resolves.toMatchObject({ recovered: true });
    expect(mocks.buyNumber).toHaveBeenCalledTimes(1);
  });

  it.each([
    "profile transport timeout",
    "profile HTTP 408",
    "profile HTTP 429",
    "profile HTTP 500",
    "malformed profile success response",
  ])(
    "persists a pre-attempt gate and never repeats profile creation after %s",
    async (scenario) => {
      process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
      mocks.createMessagingProfile.mockRejectedValueOnce(
        new mocks.TelnyxMutationUncertainError(
          `${scenario}: profile reconciliation required`
        )
      );
      mocks.reserveMessagingProfileAttempt.mockResolvedValueOnce(true);
      const gate = preparedMessagingGate();
      const first = createDb({
        selectResults: [[{ id: LOCATION_ID }], [gate], [gate]],
      });

      await expect(
        callerWithDb(first.db).provisionNumber(startNumberInput())
      ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
      expect(mocks.reserveMessagingProfileAttempt).toHaveBeenCalledWith({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        senderE164: "+15555550100",
        customerReference: `openvpm:${PRACTICE_ID}:${LOCATION_ID}`,
        detail: expect.stringContaining(
          "will not create another provider profile"
        ),
      });
      expect(
        mocks.reserveMessagingProfileAttempt.mock.invocationCallOrder[0]
      ).toBeLessThan(mocks.createMessagingProfile.mock.invocationCallOrder[0]!);
      expect(first.insertValues).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messagingProfileId: null,
          senderE164: "+15555550100",
          numberSource: "purchased",
          registrationStatus: "failed",
          enabled: false,
        })
      );

      const retry = createDb({
        selectResults: [[{ id: LOCATION_ID }], [gate]],
      });
      await expect(
        callerWithDb(retry.db).provisionNumber(resumeNumberInput())
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("No additional purchase"),
      });

      expect(mocks.createMessagingProfile).toHaveBeenCalledTimes(1);
      expect(mocks.buyNumber).not.toHaveBeenCalled();
      expect(mocks.releaseMessagingProfileAttempt).not.toHaveBeenCalled();
    }
  );

  it("keeps resume read-only when the exact profile later becomes visible", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const gate = preparedMessagingGate();
    mocks.reserveMessagingProfileAttempt.mockResolvedValueOnce(true);
    mocks.findMessagingProfilesByName
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "profile_123",
          name: `OpenVPM provision ${LOCATION_ID}`,
          webhookUrl: "https://app.example.com/api/webhooks/telnyx",
          enabled: false,
        },
      ]);
    mocks.createMessagingProfile.mockRejectedValueOnce(
      new mocks.TelnyxMutationUncertainError("profile response timed out")
    );
    const first = createDb({
      selectResults: [[{ id: LOCATION_ID }], [gate], [gate]],
    });
    await expect(
      callerWithDb(first.db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    const retry = createDb({
      selectResults: [[{ id: LOCATION_ID }], [gate], [gate]],
    });
    await expect(
      callerWithDb(retry.db).provisionNumber(resumeNumberInput())
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(mocks.createMessagingProfile).toHaveBeenCalledTimes(1);
    expect(mocks.buyNumber).not.toHaveBeenCalled();
    expect(mocks.releaseMessagingProfileAttempt).not.toHaveBeenCalled();
  });

  it("fails closed on duplicate, mismatched, and inconclusive order records", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.findMessagingProfilesByName.mockResolvedValue([
      {
        id: "profile_123",
        name: `OpenVPM provision ${LOCATION_ID}`,
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        enabled: false,
      },
    ]);
    mocks.findNumberOrdersByCustomerReference.mockResolvedValue([
      {
        id: "order_1",
        status: "pending",
        customerReference: `openvpm:${PRACTICE_ID}:${LOCATION_ID}`,
        messagingProfileId: "different_profile",
        phoneNumbers: ["+15555550100"],
      },
    ]);
    const { db } = createDb({
      selectResults: [
        [{ id: LOCATION_ID }],
        [
          {
            provider: "telnyx",
            messagingProfileId: "profile_123",
            senderE164: "+15555550100",
            numberSource: "purchased",
            registrationStatus: "failed",
          },
        ],
      ],
    });

    await expect(
      callerWithDb(db).provisionNumber(resumeNumberInput())
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("No additional purchase"),
    });
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("requires literal charge authorization and a current immutable quote", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const noConfirmation = createDb();
    await expect(
      callerWithDb(noConfirmation.db).provisionNumber({
        ...startNumberInput(),
        confirmProviderCharges: false,
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    mocks.reserveMessagingProfileAttempt
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mocks.findAvailableNumberQuotes
      .mockResolvedValueOnce([
        {
          phoneNumber: "+15555550100",
          upfrontCost: "4.00",
          monthlyCost: "6.54",
          currency: "USD",
        },
      ])
      .mockResolvedValueOnce([
        { phoneNumber: "+15555550100", ...SELECTED_QUOTE },
      ]);
    const gate = preparedMessagingGate();
    const changedQuote = createDb({
      selectResults: [[{ id: LOCATION_ID }], [gate]],
    });
    await expect(
      callerWithDb(changedQuote.db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("price changed"),
    });
    expect(mocks.releaseMessagingProfileAttempt).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      locationId: LOCATION_ID,
      senderE164: "+15555550100",
      customerReference: `openvpm:${PRACTICE_ID}:${LOCATION_ID}`,
      detail: expect.stringContaining(
        "will not create another provider profile"
      ),
    });
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();

    const retryAfterRelease = createDb({
      selectResults: [[{ id: LOCATION_ID }], [gate]],
    });
    await expect(
      callerWithDb(retryAfterRelease.db).provisionNumber(startNumberInput())
    ).resolves.toMatchObject({
      ok: true,
      senderE164: "+15555550100",
    });
    expect(mocks.createMessagingProfile).toHaveBeenCalledTimes(1);
    expect(mocks.buyNumber).toHaveBeenCalledTimes(1);
  });

  it("releases an untouched gate when provider configuration is missing before the first request", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const gate = preparedMessagingGate();
    mocks.findMessagingProfilesByName.mockRejectedValueOnce(
      new mocks.TelnyxNotConfiguredError()
    );

    const missingConfig = createDb({
      selectResults: [[{ id: LOCATION_ID }], [gate], [gate]],
    });
    await expect(
      callerWithDb(missingConfig.db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(mocks.releaseMessagingProfileAttempt).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      locationId: LOCATION_ID,
      senderE164: "+15555550100",
      customerReference: `openvpm:${PRACTICE_ID}:${LOCATION_ID}`,
      detail: expect.stringContaining(
        "will not create another provider profile"
      ),
    });
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();

    const retryAfterConfiguration = createDb({
      selectResults: [[{ id: LOCATION_ID }], [gate]],
    });
    await expect(
      callerWithDb(retryAfterConfiguration.db).provisionNumber(
        startNumberInput()
      )
    ).resolves.toMatchObject({
      ok: true,
      senderE164: "+15555550100",
    });
    expect(mocks.createMessagingProfile).toHaveBeenCalledTimes(1);
    expect(mocks.buyNumber).toHaveBeenCalledTimes(1);
  });

  it("retains the gate when provider configuration disappears after profile creation", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const gate = preparedMessagingGate();
    mocks.findOwnedPhoneNumbers.mockRejectedValueOnce(
      new mocks.TelnyxNotConfiguredError()
    );

    const interruptedAfterProfile = createDb({
      selectResults: [[{ id: LOCATION_ID }], [gate], [gate]],
    });
    await expect(
      callerWithDb(interruptedAfterProfile.db).provisionNumber(
        startNumberInput()
      )
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(mocks.createMessagingProfile).toHaveBeenCalledTimes(1);
    expect(mocks.releaseMessagingProfileAttempt).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();

    mocks.findMessagingProfilesByName.mockResolvedValueOnce([
      {
        id: "profile_123",
        name: `OpenVPM provision ${LOCATION_ID}`,
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        enabled: false,
      },
    ]);
    const retry = createDb({
      selectResults: [
        [{ id: LOCATION_ID }],
        [
          {
            ...gate,
            messagingProfileId: "profile_123",
          },
        ],
      ],
    });
    await expect(
      callerWithDb(retry.db).provisionNumber(resumeNumberInput())
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("No additional purchase"),
    });

    expect(mocks.createMessagingProfile).toHaveBeenCalledTimes(1);
    expect(mocks.releaseMessagingProfileAttempt).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("fails closed when deterministic provider profiles are duplicated", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.findMessagingProfilesByName.mockResolvedValue([
      {
        id: "profile_1",
        name: `OpenVPM provision ${LOCATION_ID}`,
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        enabled: false,
      },
      {
        id: "profile_2",
        name: `OpenVPM provision ${LOCATION_ID}`,
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        enabled: false,
      },
    ]);
    const { db } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("more than one incomplete"),
    });

    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("refuses to recover a provider profile that is already enabled", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.findMessagingProfilesByName.mockResolvedValue([
      {
        id: "profile_123",
        name: `OpenVPM provision ${LOCATION_ID}`,
        webhookUrl: "https://app.example.com/api/webhooks/telnyx",
        enabled: true,
      },
    ]);
    const { db } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("unsafe settings"),
    });

    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("retains an accepted order identity when the durable write fails", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.findOwnedPhoneNumbers
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "number_123",
          phoneNumber: "+15555550100",
          messagingProfileId: "profile_123",
          status: "active",
        },
      ]);
    const { db, insertUpdate, insertValues } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });
    insertUpdate
      .mockRejectedValueOnce(new Error("database write failed"))
      .mockResolvedValueOnce(undefined);

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.not.stringContaining("database write failed"),
    });

    expect(mocks.deleteOwnedPhoneNumber).not.toHaveBeenCalled();
    expect(mocks.deleteMessagingProfile).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messagingProfileId: "profile_123",
        senderE164: "+15555550100",
        registrationStatus: "failed",
        enabled: false,
      })
    );
    expect(errorLog).toHaveBeenCalledWith(
      "Unexpected messaging provisioning failure",
      expect.any(Error)
    );
  });

  it("does not let older compensation overwrite a newer completed retry", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db, insertUpdate, insertValues } = createDb({
      selectResults: [
        [{ id: LOCATION_ID }],
        [],
        [
          {
            provider: "telnyx",
            messagingProfileId: "profile_123",
            senderE164: "+15555550100",
            numberSource: "purchased",
            registrationStatus: "not_started",
          },
        ],
      ],
    });
    insertUpdate.mockRejectedValueOnce(new Error("database write failed"));

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    expect(mocks.deleteOwnedPhoneNumber).not.toHaveBeenCalled();
    expect(mocks.deleteMessagingProfile).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(1);
  });

  it("keeps a deterministic profile recoverable after an uncertain order timeout", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.buyNumber.mockRejectedValue(
      new mocks.TelnyxMutationUncertainError("request outcome uncertain")
    );
    const { db, insertValues } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    expect(mocks.deleteOwnedPhoneNumber).not.toHaveBeenCalled();
    expect(mocks.deleteMessagingProfile).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messagingProfileId: "profile_123",
        registrationStatus: "failed",
      })
    );
  });

  it("rechecks the kill switch immediately before a number purchase", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.createMessagingProfile.mockImplementation(async () => {
      process.env.MESSAGING_PROVISIONING_ENABLED = "false";
      return { id: "profile_123" };
    });
    const { db, insertValues } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).provisionNumber(startNumberInput())
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(mocks.buyNumber).not.toHaveBeenCalled();
    expect(mocks.deleteMessagingProfile).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messagingProfileId: "profile_123",
        registrationStatus: "failed",
      })
    );
  });

  it("rejects enable toggles for stale or deleted locations before updating", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).setEnabled({ locationId: LOCATION_ID, enabled: true })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects enabling SMS before carrier registration is active", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).setEnabled({ locationId: LOCATION_ID, enabled: true })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Carrier registration must be active before enabling SMS sending.",
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale sender activation when readiness changes before the final write", async () => {
    const { db, updateSet, updateWhere } = createDb({
      selectResults: [[{ id: LOCATION_ID }], [{ locationId: LOCATION_ID }]],
      updateRows: [],
    });

    await expect(
      callerWithDb(db).setEnabled({ locationId: LOCATION_ID, enabled: true })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "Messaging sender changed while enabling. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({
      enabled: true,
      updatedAt: expect.any(Date),
    });
    const condition = updateWhere.mock.calls[0]?.[0];
    expect(
      sqlIncludesColumnParamPair(condition, "registration_status", "active")
    ).toBe(true);
  });

  it("allows disabling an inactive sender so stale enabled state can be cleared", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: LOCATION_ID }]],
      updateRows: [{ enabled: false }],
    });

    await expect(
      callerWithDb(db).setEnabled({ locationId: LOCATION_ID, enabled: false })
    ).resolves.toEqual({ ok: true, enabled: false });

    expect(updateSet).toHaveBeenCalledWith({
      enabled: false,
      updatedAt: expect.any(Date),
    });
  });

  it("keeps hosted location enablement default-off even for an active Telnyx sender", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    const { db, updateSet } = createDb({
      practiceRows: [
        {
          tier: "cloud",
          billingStatus: "active",
          trialEndsAt: null,
        },
      ],
      selectResults: [[{ id: PRACTICE_ID }], [{ id: LOCATION_ID }]],
    });

    await expect(
      callerWithDb(db).setEnabled({ locationId: LOCATION_ID, enabled: true })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("not enabled for this clinic pilot"),
    });
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("allows one explicitly allowlisted active Telnyx hosted location to be enabled", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("MESSAGING_SENDING_ENABLED", "true");
    vi.stubEnv("MESSAGING_SENDING_PRACTICE_IDS", PRACTICE_ID);
    vi.stubEnv("MESSAGING_SENDING_LOCATION_IDS", LOCATION_ID);
    const { db, updateSet } = createDb({
      practiceRows: [
        {
          tier: "cloud",
          billingStatus: "active",
          trialEndsAt: null,
        },
      ],
      selectResults: [
        [{ id: PRACTICE_ID }],
        [{ id: LOCATION_ID }],
        [{ locationId: LOCATION_ID, provider: "telnyx" }],
        [],
      ],
      updateRows: [{ enabled: true }],
    });

    await expect(
      callerWithDb(db).setEnabled({ locationId: LOCATION_ID, enabled: true })
    ).resolves.toEqual({ ok: true, enabled: true });
    expect(updateSet).toHaveBeenCalledWith({
      enabled: true,
      updatedAt: expect.any(Date),
    });
  });

  it("rejects test sends when no active registered sender exists", async () => {
    const { db } = createDb({
      selectResults: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).testSend({
        locationId: LOCATION_ID,
        to: "+15555550100",
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("disables arbitrary hosted test destinations before sender or provider work", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    const { db, select } = createDb({
      practiceRows: [
        {
          tier: "cloud",
          billingStatus: "active",
          trialEndsAt: null,
        },
      ],
    });

    await expect(
      callerWithDb(db).testSend({
        locationId: LOCATION_ID,
        to: "+15555550100",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("test sends are disabled"),
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("sends a test SMS after validating the active location sender", async () => {
    mocks.sendSms.mockResolvedValue({ success: true, sid: "sms_123" });
    const { db } = createDb({
      selectResults: [[{ id: LOCATION_ID }], [{ locationId: LOCATION_ID }]],
    });

    await expect(
      callerWithDb(db).testSend({
        locationId: LOCATION_ID,
        to: "(555) 555-0100",
      })
    ).resolves.toEqual({ ok: true, id: "sms_123" });

    expect(mocks.sendSms).toHaveBeenCalledWith({
      to: "+15555550100",
      body: "OpenVPM test message — your texting is set up correctly.",
      practiceId: PRACTICE_ID,
      locationId: LOCATION_ID,
    });
  });
});

describe("messaging location sender join scoping", () => {
  function readSource(path: string) {
    return readFileSync(path, "utf8");
  }

  function expectScopedLocationJoin(source: string, practiceExpr: string) {
    expect(source).toMatch(
      new RegExp(
        `innerJoin\\(\\s*locations,\\s*and\\(\\s*eq\\(locations\\.id, locationMessaging\\.locationId\\),\\s*eq\\(locations\\.practiceId, ${practiceExpr.replace(
          ".",
          "\\."
        )}\\),\\s*(?:activePracticePredicate\\(${practiceExpr.replace(
          ".",
          "\\."
        )}\\),\\s*)?isNull\\(locations\\.deletedAt\\)\\s*\\)\\s*\\)`,
        "s"
      )
    );
  }

  it("scopes dashboard sender lookups to active tenant locations", () => {
    for (const path of [
      "server/routers/messaging.ts",
      "server/routers/communications.ts",
      "server/routers/notifications.ts",
    ]) {
      expectScopedLocationJoin(readSource(path), "ctx.practiceId");
    }
  });

  it("scopes messaging status joins to active tenant messaging rows", () => {
    const source = readSource("server/routers/messaging.ts");
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function activePracticeWhere");
    expect(source).toContain("throw practiceNotFound()");
    expect(source).toContain('getPlan(practice.tier ?? "free")');
    expect(source).not.toContain('practice?.tier ?? "free"');

    const statusJoins = source.match(
      /leftJoin\(\s*locationMessaging,\s*and\([\s\S]+?isNull\(locationMessaging\.deletedAt\)[\s\S]+?\)\s*\)/g
    );

    expect(statusJoins).toHaveLength(2);
    for (const join of statusJoins ?? []) {
      expect(join).toContain("eq(locationMessaging.locationId, locations.id)");
      expect(join).toContain(
        "eq(locationMessaging.practiceId, ctx.practiceId)"
      );
      expect(join).toContain("activePracticePredicate(ctx.practiceId)");
      expect(join).toContain("isNull(locationMessaging.deletedAt)");
    }
  });

  it("ignores soft-deleted messaging configs in sender lookups", () => {
    for (const path of [
      "server/routers/messaging.ts",
      "server/routers/communications.ts",
      "server/routers/notifications.ts",
      "app/api/cron/reminders/route.ts",
      "lib/messaging/inbound.ts",
      "lib/messaging/index.ts",
    ]) {
      expect(readSource(path)).toContain("isNull(locationMessaging.deletedAt)");
    }
  });

  it("requires active sender lookups to have a nonblank sender or messaging profile", () => {
    expect(readSource("lib/messaging/sender-query.ts")).toContain(
      "nullif(trim(${locationMessaging.senderE164}), '') is not null"
    );
    expect(readSource("lib/messaging/sender-query.ts")).toContain(
      "nullif(trim(${locationMessaging.messagingProfileId}), '') is not null"
    );

    for (const path of [
      "server/routers/messaging.ts",
      "server/routers/communications.ts",
      "server/routers/notifications.ts",
      "app/api/cron/reminders/route.ts",
      "lib/messaging/index.ts",
    ]) {
      const source = readSource(path);
      expect(source).toContain("hasNonBlankMessagingSender()");
      expect(source).not.toContain("isNotNull(locationMessaging.senderE164)");
      expect(source).not.toContain(
        "isNotNull(locationMessaging.messagingProfileId)"
      );
    }
  });

  it("scopes cron and webhook sender lookups to active matching locations", () => {
    expectScopedLocationJoin(
      readSource("app/api/cron/reminders/route.ts"),
      "practiceId"
    );
    expectScopedLocationJoin(
      readSource("lib/messaging/inbound.ts"),
      "locationMessaging.practiceId"
    );
  });

  it("scopes inbound SMS webhook sender lookup by provider", () => {
    const source = readSource("lib/messaging/inbound.ts");

    expect(source).toContain("eq(locationMessaging.provider, provider)");
    expect(source).toContain("findMessagingLocationForWebhook");
    expect(source).toContain("locationMessaging.messagingProfileId");
    expect(readSource("app/api/webhooks/telnyx/route.ts")).toContain(
      "findMessagingLocationForWebhook({"
    );
    expect(readSource("app/api/webhooks/telnyx/route.ts")).toContain(
      'provider: "telnyx"'
    );
    expect(readSource("app/api/webhooks/twilio/route.ts")).toContain(
      "findMessagingLocationForWebhook({"
    );
    expect(readSource("app/api/webhooks/twilio/route.ts")).toContain(
      'provider: "twilio"'
    );
    expect(readSource("app/api/webhooks/twilio/route.ts")).toContain(
      "handleInboundSmsReply({"
    );
  });

  it("requires practice context and scopes shared sender resolution to that active location", () => {
    const source = readSource("lib/messaging/index.ts");

    expect(source).toContain("if (!opts.practiceId) return undefined");
    expect(source).toMatch(
      /innerJoin\(\s*locations,\s*and\(\s*eq\(locations\.id, locationMessaging\.locationId\),\s*eq\(locations\.practiceId, opts\.practiceId!\),\s*isNull\(locations\.deletedAt\)\s*\)\s*\)/s
    );
    expect(source).toContain(
      "eq(locationMessaging.practiceId, opts.practiceId!)"
    );
  });
});
