import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const IDENTITY_SECRET = "stable-identity-secret-that-is-at-least-32-bytes";
const PREVIOUS_IDENTITY_SECRET =
  "previous-identity-secret-that-is-at-least-32-bytes";

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
const { emailPreferenceIdentityKeyFingerprint, emailPreferenceRecipientHash } =
  await import("../email-preferences");

function fingerprint(secret = IDENTITY_SECRET): string {
  const value = emailPreferenceIdentityKeyFingerprint({
    identitySecret: secret,
  });
  if (!value) throw new Error("test identity key is invalid");
  return value;
}

function queueIdentityAndPreference(preference: unknown[] = []): void {
  mocks.selectResults.push(
    [
      {
        identityKeyFingerprint: fingerprint(),
        previousIdentityKeyFingerprint: null,
      },
    ],
    preference,
  );
}

function rotationKey(secret: string, email: string) {
  const emailHash = emailPreferenceRecipientHash(email, {
    identitySecret: secret,
  });
  if (!emailHash) throw new Error("test recipient hash is invalid");
  return { fingerprint: fingerprint(secret), emailHash };
}

function queueRotationRecipient(
  email: string,
  currentPreference: unknown[] = [],
  previousPreference: unknown[] = [],
): {
  current: ReturnType<typeof rotationKey>;
  previous: ReturnType<typeof rotationKey>;
} {
  const current = rotationKey(IDENTITY_SECRET, email);
  const previous = rotationKey(PREVIOUS_IDENTITY_SECRET, email);
  mocks.selectResults.push(
    [
      {
        identityKeyFingerprint: current.fingerprint,
        previousIdentityKeyFingerprint: previous.fingerprint,
      },
    ],
    [
      {
        currentIdentityKeyFingerprint: current.fingerprint,
        currentEmailHash: current.emailHash,
        previousIdentityKeyFingerprint: previous.fingerprint,
        previousEmailHash: previous.emailHash,
      },
    ],
    currentPreference,
    previousPreference,
  );
  return { current, previous };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.returningResults.length = 0;
  mocks.insertTargets.length = 0;
  vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET", IDENTITY_SECRET);
  vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platform email preference persistence", () => {
  it("reports persisted identity-key readiness without exposing the key", async () => {
    mocks.selectResults.push(
      [
        {
          identityKeyFingerprint: fingerprint(),
          previousIdentityKeyFingerprint: null,
        },
      ],
      [
        {
          identityKeyFingerprint: "f".repeat(64),
          previousIdentityKeyFingerprint: null,
        },
      ],
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
      identityKeyFingerprint: fingerprint(),
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
      identityKeyFingerprint: fingerprint(),
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
        identityKeyFingerprint: fingerprint(),
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
        identityKeyFingerprint: fingerprint(),
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
    mocks.selectResults.push([
      {
        identityKeyFingerprint: "f".repeat(64),
        previousIdentityKeyFingerprint: null,
      },
    ]);

    await expect(
      marketingEmailEnabledForRecipient("owner@example.com"),
    ).rejects.toBeInstanceOf(PlatformEmailIdentityKeyMismatchError);
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
  });

  it("fails closed when persisted rotation metadata requires an unavailable previous key", async () => {
    mocks.selectResults.push([
      {
        identityKeyFingerprint: fingerprint(),
        previousIdentityKeyFingerprint: fingerprint(PREVIOUS_IDENTITY_SECRET),
      },
    ]);

    await expect(
      marketingEmailEnabledForRecipient("owner@example.com"),
    ).rejects.toBeInstanceOf(PlatformEmailIdentityKeyMismatchError);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("uses the strongest suppression across both identity projections", async () => {
    vi.stubEnv(
      "EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS",
      PREVIOUS_IDENTITY_SECRET,
    );
    const { current, previous } = queueRotationRecipient(
      "owner@example.com",
      [
        {
          marketingEnabled: true,
          source: "settings",
          reason: "settings_enabled",
          identityKeyFingerprint: fingerprint(),
          updatedByUserId: null,
        },
      ],
      [
        {
          marketingEnabled: false,
          source: "resend_webhook",
          reason: "bounce",
          identityKeyFingerprint: fingerprint(PREVIOUS_IDENTITY_SECRET),
          updatedByUserId: null,
        },
      ],
    );

    await expect(
      marketingEmailEnabledForRecipient("owner@example.com"),
    ).resolves.toBe(false);

    expect(mocks.execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(mocks.execute.mock.calls[0])).toContain(
      "pg_advisory_xact_lock_shared",
    );
    const sortedHashes = [current.emailHash, previous.emailHash].sort();
    expect(JSON.stringify(mocks.execute.mock.calls[1])).toContain(
      sortedHashes[0],
    );
    expect(JSON.stringify(mocks.execute.mock.calls[2])).toContain(
      sortedHashes[1],
    );
    expect(mocks.insertValues).toHaveBeenCalledWith({
      currentIdentityKeyFingerprint: current.fingerprint,
      currentEmailHash: current.emailHash,
      previousIdentityKeyFingerprint: previous.fingerprint,
      previousEmailHash: previous.emailHash,
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        emailHash: current.emailHash,
        marketingEnabled: false,
        reason: "bounce",
      }),
    );
    expect(JSON.stringify(mocks.insertValues.mock.calls)).not.toContain(
      "owner@example.com",
    );
  });

  it("fails closed rather than accepting a conflicting alias", async () => {
    vi.stubEnv(
      "EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS",
      PREVIOUS_IDENTITY_SECRET,
    );
    const current = rotationKey(IDENTITY_SECRET, "owner@example.com");
    const previous = rotationKey(PREVIOUS_IDENTITY_SECRET, "owner@example.com");
    mocks.selectResults.push(
      [
        {
          identityKeyFingerprint: current.fingerprint,
          previousIdentityKeyFingerprint: previous.fingerprint,
        },
      ],
      [
        {
          currentIdentityKeyFingerprint: current.fingerprint,
          currentEmailHash: current.emailHash,
          previousIdentityKeyFingerprint: previous.fingerprint,
          previousEmailHash: "f".repeat(64),
        },
      ],
    );

    await expect(
      marketingEmailEnabledForRecipient("owner@example.com"),
    ).rejects.toBeInstanceOf(PlatformEmailIdentityKeyMismatchError);
    expect(mocks.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("blocks settings re-enable when the previous projection has a hard bounce", async () => {
    vi.stubEnv(
      "EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS",
      PREVIOUS_IDENTITY_SECRET,
    );
    queueRotationRecipient(
      "owner@example.com",
      [],
      [
        {
          marketingEnabled: false,
          source: "resend_webhook",
          reason: "bounce",
          identityKeyFingerprint: fingerprint(PREVIOUS_IDENTITY_SECRET),
          updatedByUserId: null,
        },
      ],
    );

    await expect(
      setMarketingEmailPreferenceForRecipient({
        email: "owner@example.com",
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
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({
        marketingEnabled: true,
        reason: "settings_enabled",
      }),
    );
  });

  it("dual-writes a new preference and makes its replay a no-op", async () => {
    vi.stubEnv(
      "EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS",
      PREVIOUS_IDENTITY_SECRET,
    );
    queueRotationRecipient("owner@example.com");

    await setMarketingEmailPreferenceForRecipient({
      email: "owner@example.com",
      enabled: false,
      source: "settings",
    });

    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.insertValues.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            requestedMarketingEnabled: false,
            applied: true,
            reason: "settings_disabled",
          }),
        ],
      ]),
    );

    vi.clearAllMocks();
    mocks.selectResults.length = 0;
    mocks.returningResults.length = 0;
    mocks.insertTargets.length = 0;
    const { current, previous } = queueRotationRecipient(
      "owner@example.com",
      [
        {
          marketingEnabled: false,
          source: "settings",
          reason: "settings_disabled",
          identityKeyFingerprint: fingerprint(),
          updatedByUserId: null,
        },
      ],
      [
        {
          marketingEnabled: false,
          source: "settings",
          reason: "settings_disabled",
          identityKeyFingerprint: fingerprint(PREVIOUS_IDENTITY_SECRET),
          updatedByUserId: null,
        },
      ],
    );

    await setMarketingEmailPreferenceForRecipient({
      email: "owner@example.com",
      enabled: false,
      source: "settings",
    });

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).toHaveBeenCalledWith({
      currentIdentityKeyFingerprint: current.fingerprint,
      currentEmailHash: current.emailHash,
      previousIdentityKeyFingerprint: previous.fingerprint,
      previousEmailHash: previous.emailHash,
    });
    expect(mocks.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("accepts a registered legacy hash without deriving an alias from hashes alone", async () => {
    vi.stubEnv(
      "EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS",
      PREVIOUS_IDENTITY_SECRET,
    );
    const current = rotationKey(IDENTITY_SECRET, "owner@example.com");
    const previous = rotationKey(PREVIOUS_IDENTITY_SECRET, "owner@example.com");
    mocks.selectResults.push(
      [
        {
          identityKeyFingerprint: current.fingerprint,
          previousIdentityKeyFingerprint: previous.fingerprint,
        },
      ],
      [],
      [],
    );

    await setMarketingEmailPreferenceForHash({
      emailHash: previous.emailHash,
      identityKeyFingerprint: previous.fingerprint,
      enabled: false,
      source: "unsubscribe_link",
    });

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        emailHash: previous.emailHash,
        identityKeyFingerprint: previous.fingerprint,
        reason: "unsubscribe",
      }),
    );
    expect(mocks.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ currentEmailHash: expect.any(String) }),
    );
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
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
        identityKeyFingerprint: fingerprint(),
        enabled: false,
        source: "unsubscribe_link",
      }),
    ).rejects.toThrow("invalid email preference recipient hash");
    await expect(
      setMarketingEmailPreferenceForHash({
        emailHash: "d".repeat(64),
        identityKeyFingerprint: fingerprint(),
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
