import { afterEach, describe, expect, it, vi } from "vitest";

const { messagingRouter } = await import("../routers/messaging");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>, role = "front_desk") {
  const session = {
    user: {
      id: USER_ID,
      email: "staff@example.com",
      name: "Staff",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return messagingRouter.createCaller({ db, session } as never);
}

function thenableRows(rows: Record<string, unknown>[]) {
  return {
    limit: vi.fn(async () => rows),
    then: (
      resolve: (value: Record<string, unknown>[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
}

function createDb(rows: Record<string, unknown>[]) {
  const results = [[{ id: PRACTICE_ID }], rows];
  const where = vi.fn(() => thenableRows(results.shift() ?? []));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin, where }));
  const select = vi.fn(() => ({ from }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };

  return { db, where };
}

afterEach(() => vi.unstubAllEnvs());

describe("messaging.getInboxStatus", () => {
  it("is visible to non-admin staff and reports setup prompts", async () => {
    const { db } = createDb([
      {
        locationId: "00000000-0000-0000-0000-000000000002",
        name: "Main Clinic",
        provider: null,
        senderE164: null,
        messagingProfileId: null,
        registrationStatus: null,
        enabled: null,
      },
    ]);

    await expect(callerWithDb(db).getInboxStatus()).resolves.toMatchObject({
      canManage: false,
      summary: {
        kind: "not_configured",
        smsComposeEnabled: false,
        showBanner: true,
      },
    });
  });

  it("marks admins as able to manage messaging setup", async () => {
    const { db } = createDb([
      {
        locationId: "00000000-0000-0000-0000-000000000002",
        name: "Main Clinic",
        provider: "telnyx",
        senderE164: "+15555550100",
        messagingProfileId: null,
        registrationStatus: "active",
        enabled: true,
      },
    ]);

    await expect(
      callerWithDb(db, "admin").getInboxStatus(),
    ).resolves.toMatchObject({
      canManage: true,
      summary: {
        kind: "ready",
        smsComposeEnabled: true,
        showBanner: false,
      },
    });
  });

  it("reports an active DB sender as unavailable while the hosted launch gate is off", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    const { db } = createDb([
      {
        locationId: "00000000-0000-0000-0000-000000000002",
        name: "Main Clinic",
        provider: "telnyx",
        senderE164: "+15555550100",
        messagingProfileId: null,
        registrationStatus: "active",
        enabled: true,
      },
    ]);

    await expect(callerWithDb(db).getInboxStatus()).resolves.toMatchObject({
      locations: [{ messaging: { launchEligible: false } }],
      summary: {
        kind: "disabled",
        smsComposeEnabled: false,
        title: "Texting pilot is not active for this clinic",
      },
    });
  });

  it("treats profile-only active senders as ready for the shared inbox", async () => {
    const { db } = createDb([
      {
        locationId: "00000000-0000-0000-0000-000000000002",
        name: "Main Clinic",
        provider: "telnyx",
        senderE164: null,
        messagingProfileId: " profile-1 ",
        registrationStatus: "active",
        enabled: true,
      },
    ]);

    await expect(callerWithDb(db).getInboxStatus()).resolves.toMatchObject({
      summary: {
        kind: "ready",
        smsComposeEnabled: true,
        showBanner: false,
      },
    });
  });

  it("does not show SMS compose ready for whitespace-only sender fields", async () => {
    const { db } = createDb([
      {
        locationId: "00000000-0000-0000-0000-000000000002",
        name: "Main Clinic",
        provider: "telnyx",
        senderE164: "   ",
        messagingProfileId: "\t",
        registrationStatus: "active",
        enabled: true,
      },
    ]);

    await expect(callerWithDb(db).getInboxStatus()).resolves.toMatchObject({
      summary: {
        kind: "action_required",
        smsComposeEnabled: false,
        showBanner: true,
      },
    });
  });
});

describe("messaging.activationSummary", () => {
  const activeRow = {
    locationId: "00000000-0000-0000-0000-000000000002",
    provider: "telnyx",
    senderE164: "+15555550100",
    registrationStatus: "active",
    enabled: true,
  };

  it("does not claim hosted texting is active while launch remains off", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    const { db } = createDb([activeRow]);
    await expect(
      callerWithDb(db, "admin").activationSummary(),
    ).resolves.toEqual({
      setupAvailable: false,
      hasAnyNumber: true,
      hasActiveNumber: false,
    });
  });

  it("reports setup availability only for an allowlisted hosted clinic", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("MESSAGING_PROVISIONING_ENABLED", "true");
    vi.stubEnv("MESSAGING_PROVISIONING_PRACTICE_IDS", PRACTICE_ID);
    const { db } = createDb([]);

    await expect(
      callerWithDb(db, "admin").activationSummary(),
    ).resolves.toEqual({
      setupAvailable: true,
      hasAnyNumber: false,
      hasActiveNumber: false,
    });
  });

  it("preserves self-host active sender behavior", async () => {
    const { db } = createDb([activeRow]);
    await expect(
      callerWithDb(db, "admin").activationSummary(),
    ).resolves.toEqual({
      setupAvailable: false,
      hasAnyNumber: true,
      hasActiveNumber: true,
    });
  });
});
