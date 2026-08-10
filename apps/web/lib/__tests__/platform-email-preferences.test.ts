import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const IDENTITY_SECRET = "stable-identity-secret-that-is-at-least-32-bytes";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const returningResults: unknown[][] = [];
  const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const returning = vi.fn(async () => returningResults.shift() ?? []);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const insertValues = vi.fn(() => ({
    onConflictDoNothing,
    onConflictDoUpdate,
  }));
  const insertTargets: unknown[] = [];
  const insert = vi.fn((table: unknown) => {
    insertTargets.push(table);
    return { values: insertValues };
  });
  const execute = vi.fn(async () => undefined);
  const db = { execute, select, insert };
  return {
    db,
    selectResults,
    returningResults,
    insertTargets,
    execute,
    insertValues,
    onConflictDoNothing,
    onConflictDoUpdate,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));

const {
  marketingEmailEnabledForRecipient,
  platformEmailIdentityConfigurationReady,
  PlatformEmailIdentityKeyMismatchError,
  PlatformEmailPreferenceBlockedError,
  recordPlatformEmailDeliverySuppression,
  setMarketingEmailPreferenceForHash,
  setMarketingEmailPreferenceForRecipient,
} = await import("../platform-email-preferences");
const { emailPreferenceIdentityKeyFingerprint } =
  await import("../email-preferences");

function fingerprint(): string {
  const value = emailPreferenceIdentityKeyFingerprint({
    identitySecret: IDENTITY_SECRET,
  });
  if (!value) throw new Error("test identity key is invalid");
  return value;
}

function queueIdentityAndPreference(preference: unknown[] = []): void {
  mocks.selectResults.push(
    [{ identityKeyFingerprint: fingerprint() }],
    preference,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.returningResults.length = 0;
  mocks.insertTargets.length = 0;
  vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET", IDENTITY_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform email preference persistence", () => {
  it("reports persisted identity-key readiness without exposing the key", async () => {
    mocks.selectResults.push(
      [{ identityKeyFingerprint: fingerprint() }],
      [{ identityKeyFingerprint: "f".repeat(64) }],
    );

    await expect(platformEmailIdentityConfigurationReady()).resolves.toEqual({
      ready: true,
      initialized: true,
    });
    await expect(platformEmailIdentityConfigurationReady()).resolves.toEqual({
      ready: false,
      initialized: true,
    });
  });

  it("defaults on and respects a recipient-level opt-out", async () => {
    queueIdentityAndPreference();
    queueIdentityAndPreference([
      {
        marketingEnabled: false,
        reason: "unsubscribe",
        identityKeyFingerprint: fingerprint(),
      },
    ]);

    await expect(
      marketingEmailEnabledForRecipient("owner@example.com"),
    ).resolves.toBe(true);
    await expect(
      marketingEmailEnabledForRecipient("OWNER@example.com "),
    ).resolves.toBe(false);
  });

  it("stores only keyed hashes and appends an attributed audit event", async () => {
    queueIdentityAndPreference();

    await setMarketingEmailPreferenceForRecipient({
      email: " OWNER@Example.com ",
      enabled: false,
      source: "settings",
      updatedByUserId: "00000000-0000-4000-8000-000000000001",
    });

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        emailHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        requestedMarketingEnabled: false,
        applied: true,
        source: "settings",
        reason: "settings_disabled",
      }),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        emailHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        marketingEnabled: false,
        source: "settings",
        reason: "settings_disabled",
      }),
    );
    expect(JSON.stringify(mocks.insertValues.mock.calls)).not.toContain(
      "owner@example.com",
    );
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          marketingEnabled: false,
          deletedAt: null,
        }),
      }),
    );
  });

  it("records a repeated unsubscribe without weakening a stronger state", async () => {
    queueIdentityAndPreference([
      {
        marketingEnabled: false,
        reason: "unsubscribe",
        identityKeyFingerprint: fingerprint(),
      },
    ]);

    await setMarketingEmailPreferenceForHash({
      emailHash: "a".repeat(64),
      enabled: false,
      source: "unsubscribe_link",
    });

    // Only the singleton identity claim is attempted. The replay creates no
    // second preference event and cannot grow the ledger.
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("applies and audits the first unsubscribe", async () => {
    queueIdentityAndPreference();
    await setMarketingEmailPreferenceForHash({
      emailHash: "f".repeat(64),
      enabled: false,
      source: "unsubscribe_link",
    });

    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        applied: true,
        reason: "unsubscribe",
      }),
    );
  });

  it("audits but blocks admin re-enable after a recipient unsubscribe", async () => {
    queueIdentityAndPreference([
      {
        marketingEnabled: false,
        reason: "unsubscribe",
        identityKeyFingerprint: fingerprint(),
      },
    ]);

    await expect(
      setMarketingEmailPreferenceForHash({
        emailHash: "b".repeat(64),
        enabled: true,
        source: "settings",
        updatedByUserId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(PlatformEmailPreferenceBlockedError);

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedMarketingEnabled: true,
        applied: false,
        reason: "settings_enabled",
      }),
    );
    expect(mocks.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("audits but blocks settings re-enable after a provider complaint", async () => {
    queueIdentityAndPreference([
      {
        marketingEnabled: false,
        reason: "complaint",
        identityKeyFingerprint: fingerprint(),
      },
    ]);

    await expect(
      setMarketingEmailPreferenceForHash({
        emailHash: "c".repeat(64),
        enabled: true,
        source: "settings",
        updatedByUserId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(PlatformEmailPreferenceBlockedError);

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedMarketingEnabled: true,
        applied: false,
        reason: "settings_enabled",
      }),
    );
    expect(mocks.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("fails closed when the configured identity key differs from the durable key", async () => {
    mocks.selectResults.push([{ identityKeyFingerprint: "f".repeat(64) }]);

    await expect(
      marketingEmailEnabledForRecipient("owner@example.com"),
    ).rejects.toBeInstanceOf(PlatformEmailIdentityKeyMismatchError);
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
  });

  it("records a matched provider complaint with a PII-free idempotency key", async () => {
    queueIdentityAndPreference([
      {
        marketingEnabled: true,
        reason: "settings_enabled",
        identityKeyFingerprint: fingerprint(),
      },
    ]);
    mocks.returningResults.push([{ id: "event-id" }]);

    await expect(
      recordPlatformEmailDeliverySuppression({
        email: "owner@example.com",
        reason: "complaint",
        providerMessageId: "resend-message-123",
        webhookId: "svix-webhook-123",
      }),
    ).resolves.toEqual({ applied: true, duplicate: false });

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        emailHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        providerEventKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: "resend_webhook",
        reason: "complaint",
        applied: true,
      }),
    );
    const stored = JSON.stringify(mocks.insertValues.mock.calls);
    expect(stored).not.toContain("owner@example.com");
    expect(stored).not.toContain("resend-message-123");
    expect(stored).not.toContain("svix-webhook-123");
    expect(mocks.onConflictDoUpdate).toHaveBeenCalled();
  });

  it("returns a harmless duplicate result for a repeated provider webhook", async () => {
    queueIdentityAndPreference();
    mocks.returningResults.push([]);

    await expect(
      recordPlatformEmailDeliverySuppression({
        email: "owner@example.com",
        reason: "bounce",
        providerMessageId: "resend-message-123",
        webhookId: "svix-webhook-123",
      }),
    ).resolves.toEqual({ applied: false, duplicate: true });

    expect(mocks.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("audits a lower-precedence bounce without replacing a complaint", async () => {
    queueIdentityAndPreference([
      {
        marketingEnabled: false,
        reason: "complaint",
        identityKeyFingerprint: fingerprint(),
      },
    ]);
    mocks.returningResults.push([{ id: "event-id" }]);

    await expect(
      recordPlatformEmailDeliverySuppression({
        email: "owner@example.com",
        reason: "bounce",
        providerMessageId: "resend-message-456",
        webhookId: "svix-webhook-456",
      }),
    ).resolves.toEqual({ applied: false, duplicate: false });

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bounce", applied: false }),
    );
    expect(mocks.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("rejects malformed inputs before preference database work", async () => {
    await expect(
      setMarketingEmailPreferenceForHash({
        emailHash: "not-a-hash",
        enabled: false,
        source: "unsubscribe_link",
      }),
    ).rejects.toThrow("invalid email preference recipient hash");
    await expect(
      setMarketingEmailPreferenceForHash({
        emailHash: "d".repeat(64),
        enabled: true,
        source: "unsubscribe_link",
      }),
    ).rejects.toThrow("cannot enable");
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("fails closed when the dedicated identity key is missing", async () => {
    vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET", " ");

    await expect(
      marketingEmailEnabledForRecipient("owner@example.com"),
    ).rejects.toThrow("identity key is not configured");
    await expect(
      setMarketingEmailPreferenceForRecipient({
        email: "owner@example.com",
        enabled: false,
        source: "unsubscribe_link",
      }),
    ).rejects.toThrow("identity key is not configured");
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });
});
