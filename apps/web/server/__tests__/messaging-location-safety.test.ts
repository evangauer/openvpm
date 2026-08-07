import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockTelnyxNotConfiguredError extends Error {}
  return {
    sendSms: vi.fn(),
    searchAvailableNumbers: vi.fn(),
    checkHostedEligibility: vi.fn(),
    createMessagingProfile: vi.fn(),
    buyNumber: vi.fn(),
    createHostedOrder: vi.fn(),
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
  checkHostedEligibility: mocks.checkHostedEligibility,
  createMessagingProfile: mocks.createMessagingProfile,
  buyNumber: mocks.buyNumber,
  createHostedOrder: mocks.createHostedOrder,
  TelnyxNotConfiguredError: mocks.TelnyxNotConfiguredError,
}));

vi.mock("@/lib/billing/usage", () => ({
  usageForPractice: mocks.usageForPractice,
  currentPeriodMonth: mocks.currentPeriodMonth,
}));

const { messagingRouter } = await import("../routers/messaging");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const LOCATION_ID = "00000000-0000-0000-0000-000000000002";

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

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    update,
    insert,
  };

  return { db, select, updateSet, updateWhere, insertValues, insertUpdate };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXTAUTH_URL;
  // The platform kill-switch is on for behavior tests; the gate itself is
  // covered in "messaging provisioning kill-switch".
  vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
});

describe("messaging provisioning kill-switch", () => {
  it("blocks number search and provisioning until ops enables it", async () => {
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "");
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).provisionNumber({ locationId: LOCATION_ID, mode: "host" })
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
});

describe("messaging location target safety", () => {
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

  it("rejects invalid messaging phone inputs before DB or provider calls", async () => {
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).provisionNumber({
        locationId: LOCATION_ID,
        mode: "buy",
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
    expect(mocks.createHostedOrder).not.toHaveBeenCalled();
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
      caller.provisionNumber({ locationId: LOCATION_ID, mode: "host" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(mocks.searchAvailableNumbers).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.createHostedOrder).not.toHaveBeenCalled();
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

    expect(mocks.checkHostedEligibility).not.toHaveBeenCalled();
  });

  it("rejects provisioning stale or deleted locations before provider calls", async () => {
    const { db } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).provisionNumber({ locationId: LOCATION_ID, mode: "host" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.createHostedOrder).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("requires a public HTTPS app URL before provisioning provider webhooks", async () => {
    const missingEnv = createDb({
      selectResults: [
        [{ id: LOCATION_ID, name: "Main Clinic", phone: "(555) 555-0100" }],
      ],
    });

    await expect(
      callerWithDb(missingEnv.db).provisionNumber({
        locationId: LOCATION_ID,
        mode: "host",
      })
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
      callerWithDb(localEnv.db).provisionNumber({
        locationId: LOCATION_ID,
        mode: "host",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.createHostedOrder).not.toHaveBeenCalled();
    expect(mocks.buyNumber).not.toHaveBeenCalled();
  });

  it("falls back to NEXTAUTH_URL when NEXT_PUBLIC_APP_URL is blank", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "   ";
    process.env.NEXTAUTH_URL = "https://auth.example.com/settings";
    mocks.createMessagingProfile.mockResolvedValue({ id: "profile_123" });
    mocks.createHostedOrder.mockResolvedValue({ id: "hosted_123" });
    const { db } = createDb({
      selectResults: [
        [{ id: LOCATION_ID, name: "Main Clinic", phone: "(555) 555-0100" }],
      ],
    });

    await expect(
      callerWithDb(db).provisionNumber({
        locationId: LOCATION_ID,
        mode: "host",
      })
    ).resolves.toMatchObject({
      ok: true,
      senderE164: "+15555550100",
      numberSource: "hosted",
    });

    expect(mocks.createMessagingProfile).toHaveBeenCalledWith({
      name: "Main Clinic — OpenVPM",
      webhookUrl: "https://auth.example.com/api/webhooks/telnyx",
    });
    expect(mocks.createHostedOrder).toHaveBeenCalledWith({
      phoneNumber: "+15555550100",
      messagingProfileId: "profile_123",
    });
  });

  it("passes the public Telnyx webhook URL and reactivates sender rows", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.createMessagingProfile.mockResolvedValue({ id: "profile_123" });
    mocks.createHostedOrder.mockResolvedValue({ id: "hosted_123" });
    const { db, insertValues, insertUpdate } = createDb({
      selectResults: [
        [{ id: LOCATION_ID, name: "Main Clinic", phone: "(555) 555-0100" }],
      ],
    });

    await expect(
      callerWithDb(db).provisionNumber({
        locationId: LOCATION_ID,
        mode: "host",
      })
    ).resolves.toEqual({
      ok: true,
      senderE164: "+15555550100",
      numberSource: "hosted",
    });

    expect(mocks.createMessagingProfile).toHaveBeenCalledWith({
      name: "Main Clinic — OpenVPM",
      webhookUrl: "https://app.example.com/api/webhooks/telnyx",
    });
    expect(mocks.createHostedOrder).toHaveBeenCalledWith({
      phoneNumber: "+15555550100",
      messagingProfileId: "profile_123",
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        messagingProfileId: "profile_123",
        senderE164: "+15555550100",
        registrationStatus: "pending",
        registrationDetail: expect.stringContaining("Carrier registration"),
        enabled: false,
      })
    );
    expect(insertUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          messagingProfileId: "profile_123",
          senderE164: "+15555550100",
          registrationStatus: "pending",
          registrationDetail: expect.stringContaining("Carrier registration"),
          enabled: false,
          deletedAt: null,
          updatedAt: expect.any(Date),
        }),
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
      message: "Carrier registration must be active before enabling SMS sending.",
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
      message: "Messaging sender changed while enabling. Refresh and try again.",
    });

    expect(updateSet).toHaveBeenCalledWith({
      enabled: true,
      updatedAt: expect.any(Date),
    });
    const condition = updateWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumnParamPair(condition, "registration_status", "active")).toBe(
      true
    );
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

  it("sends a test SMS after validating the active location sender", async () => {
    mocks.sendSms.mockResolvedValue({ success: true, sid: "sms_123" });
    const { db } = createDb({
      selectResults: [[{ id: LOCATION_ID }], [{ locationId: LOCATION_ID }]],
    });

    await expect(
      callerWithDb(db).testSend({ locationId: LOCATION_ID, to: "(555) 555-0100" })
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
      expect(join).toContain(
        "eq(locationMessaging.locationId, locations.id)"
      );
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
      'handleInboundSmsReply({'
    );
  });

  it("scopes shared sender resolution to active locations with or without practice context", () => {
    const source = readSource("lib/messaging/index.ts");

    expect(source).toMatch(
      /innerJoin\(\s*locations,\s*and\(\s*eq\(locations\.id, locationMessaging\.locationId\),\s*opts\.practiceId\s*\?\s*eq\(locations\.practiceId, opts\.practiceId\)\s*:\s*eq\(locations\.practiceId, locationMessaging\.practiceId\),\s*isNull\(locations\.deletedAt\)\s*\)\s*\)/s
    );
  });
});
