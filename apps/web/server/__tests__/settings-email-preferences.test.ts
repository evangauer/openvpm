import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PlatformEmailPreferenceBlockedError extends Error {}
  return {
    PlatformEmailPreferenceBlockedError,
    marketingEmailEnabledForRecipient: vi.fn(async () => true),
    setMarketingEmailPreferenceForRecipient: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/platform-email-preferences", () => ({
  marketingEmailEnabledForRecipient: mocks.marketingEmailEnabledForRecipient,
  setMarketingEmailPreferenceForRecipient:
    mocks.setMarketingEmailPreferenceForRecipient,
  PlatformEmailPreferenceBlockedError:
    mocks.PlatformEmailPreferenceBlockedError,
}));

const { settingsRouter } = await import("../routers/settings");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return settingsRouter.createCaller({ db, session } as never);
}

function createDb(selectResults: unknown[][]) {
  const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const execute = vi.fn(async () => undefined);
  const db: Record<string, unknown> = {
    select,
    execute,
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db, select };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    "EMAIL_PREFERENCE_IDENTITY_SECRET",
    "stable-identity-secret-at-least-32-bytes",
  );
  vi.stubEnv(
    "EMAIL_PREFERENCE_SIGNING_SECRET",
    "stable-signing-secret-at-least-32-bytes",
  );
  mocks.marketingEmailEnabledForRecipient.mockResolvedValue(true);
  mocks.setMarketingEmailPreferenceForRecipient.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("settings marketing email preference", () => {
  it("defaults on when the current practice recipient has no preference", async () => {
    const { db } = createDb([[{ email: " Owner@Example.com " }], []]);

    await expect(
      callerWithDb(db).getMarketingEmailPreference(),
    ).resolves.toEqual({
      enabled: true,
      configurable: true,
      recipientEmail: "owner@example.com",
    });
  });

  it("returns the current recipient's global opt-out", async () => {
    const { db } = createDb([[{ email: "owner@example.com" }]]);
    mocks.marketingEmailEnabledForRecipient.mockResolvedValueOnce(false);

    await expect(
      callerWithDb(db).getMarketingEmailPreference(),
    ).resolves.toMatchObject({ enabled: false, configurable: true });
  });

  it("updates the normalized current recipient through the system service", async () => {
    const { db } = createDb([[{ email: " OWNER@Example.com " }]]);

    await expect(
      callerWithDb(db).setMarketingEmailPreference({ enabled: false }),
    ).resolves.toEqual({
      enabled: false,
      configurable: true,
      recipientEmail: "owner@example.com",
    });
    expect(mocks.setMarketingEmailPreferenceForRecipient).toHaveBeenCalledWith({
      email: "owner@example.com",
      enabled: false,
      source: "settings",
      updatedByUserId: USER_ID,
    });
  });

  it("requires a valid current practice email", async () => {
    const { db } = createDb([[{ email: " " }]]);

    await expect(
      callerWithDb(db).setMarketingEmailPreference({ enabled: false }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      mocks.setMarketingEmailPreferenceForRecipient,
    ).not.toHaveBeenCalled();
  });

  it("explains when recipient confirmation is required to re-consent", async () => {
    const { db } = createDb([[{ email: "owner@example.com" }]]);
    mocks.setMarketingEmailPreferenceForRecipient.mockRejectedValueOnce(
      new mocks.PlatformEmailPreferenceBlockedError(),
    );

    await expect(
      callerWithDb(db).setMarketingEmailPreference({ enabled: true }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("cannot be re-enabled"),
    });
  });

  it("does not allow non-admin staff to inspect or change preferences", async () => {
    const { db, select } = createDb([]);
    const caller = callerWithDb(db, "front_desk");

    await expect(caller.getMarketingEmailPreference()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.setMarketingEmailPreference({ enabled: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(select).not.toHaveBeenCalled();
    expect(
      mocks.setMarketingEmailPreferenceForRecipient,
    ).not.toHaveBeenCalled();
  });
});
