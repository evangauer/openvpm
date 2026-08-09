import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let systemDepth = 0;
  return {
    get systemDepth() {
      return systemDepth;
    },
    verificationEmailProvider: vi.fn((): "resend" | "console" => "resend"),
    sendVerificationEmailWithProviderEvidence: vi.fn(),
    alertOps: vi.fn(async () => undefined),
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        systemDepth += 1;
        try {
          return await fn(database);
        } finally {
          systemDepth -= 1;
        }
      },
    ),
  };
});

vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/email", () => ({
  verificationEmailProvider: mocks.verificationEmailProvider,
  sendVerificationEmailWithProviderEvidence:
    mocks.sendVerificationEmailWithProviderEvidence,
}));

const {
  AUTH_EMAIL_WEBHOOK_REPAIR_MIN_AGE_MS,
  authEmailDeliveryClassification,
  authEmailWebhookFingerprint,
  recordAuthEmailDeliveryEvent,
  sendTrackedVerificationEmail,
} = await import("../auth-email-delivery");

type ScriptValue = unknown[] | Error;

function databaseDouble(options?: {
  selectResults?: ScriptValue[];
  deliveryInsertResults?: ScriptValue[];
  updateResults?: ScriptValue[];
  insertErrorAtCall?: number;
}) {
  const selectResults = [...(options?.selectResults ?? [])];
  const deliveryInsertResults = [
    ...(options?.deliveryInsertResults ?? [[{ id: "event-recorded" }]]),
  ];
  const updateResults = [...(options?.updateResults ?? [])];
  const insertedValues: unknown[] = [];
  const updatedValues: unknown[] = [];

  const selectLimit = vi.fn(async () => {
    const next = selectResults.shift() ?? [];
    if (next instanceof Error) throw next;
    return next;
  });
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertReturning = vi.fn(async () => {
    const next = deliveryInsertResults.shift() ?? [];
    if (next instanceof Error) throw next;
    return next;
  });
  const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
  const insertValues = vi.fn((values: unknown) => {
    insertedValues.push(values);
    if (insertedValues.length === options?.insertErrorAtCall) {
      throw new Error("scripted insert failure");
    }
    return { onConflictDoNothing };
  });
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => {
    const next = updateResults.shift() ?? [];
    if (next instanceof Error) throw next;
    return next;
  });
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn((values: unknown) => {
    updatedValues.push(values);
    return { where: updateWhere };
  });
  const update = vi.fn(() => ({ set: updateSet }));

  const db = { select, insert, update };
  return {
    db,
    insertedValues,
    updatedValues,
    insertReturning,
    onConflictDoNothing,
    updateReturning,
    updateWhere,
    updateSet,
  };
}

function acceptedState(
  provider: "resend" | "console" = "resend",
  providerMessageId = "provider-email-1",
) {
  return {
    outcome: "accepted",
    provider,
    providerMessageId,
    failureCode: null,
  };
}

function webhookEvent(input?: {
  type?: string;
  tags?: Record<string, string>;
  providerMessageId?: string;
}) {
  return {
    type: input?.type ?? "email.delivered",
    created_at: "2026-08-09T12:00:00.000Z",
    data: {
      email_id: input?.providerMessageId ?? "provider-email-1",
      created_at: "2026-08-09T11:59:59.000Z",
      from: "OpenVPM <noreply@mail.openvpm.com>",
      to: ["owner@example.com"],
      subject: "Verify your OpenVPM email",
      ...(input?.tags ? { tags: input.tags } : {}),
    },
  } as never;
}

function trackedInput(db: unknown) {
  return {
    practiceId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    source: "registration" as const,
    to: "owner@example.com",
    name: "Dr Owner",
    verifyUrl: "https://app.openvpm.com/verify-email?token=never-persist-this",
    db: db as never,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.verificationEmailProvider.mockReturnValue("resend");
});

describe("tracked verification email dispatch", () => {
  it("commits reservation, calls the provider outside transactions, and resolves in another transaction", async () => {
    const { db, insertedValues, updatedValues } = databaseDouble({
      updateResults: [[acceptedState()]],
      selectResults: [[]],
    });
    mocks.sendVerificationEmailWithProviderEvidence.mockImplementation(
      async (payload: Record<string, unknown>) => {
        expect(mocks.systemDepth).toBe(0);
        expect(insertedValues).toHaveLength(1);
        expect(payload.idempotencyKey).toBe(
          `auth-email:${String(payload.attemptId)}`,
        );
        return {
          success: true,
          provider: "resend",
          id: "provider-email-1",
          outcome: "accepted",
        };
      },
    );

    const result = await sendTrackedVerificationEmail(trackedInput(db));

    expect(result).toMatchObject({
      success: true,
      provider: "resend",
      outcome: "accepted",
      possiblySent: false,
      evidencePersisted: true,
      providerMessageId: "provider-email-1",
    });
    expect(insertedValues[0]).toMatchObject({
      provider: "resend",
      source: "registration",
      idempotencyKey: `auth-email:${result.attemptId}`,
    });
    expect(updatedValues[0]).toMatchObject({
      outcome: "accepted",
      providerMessageId: "provider-email-1",
      failureCode: null,
    });
    expect(mocks.withSystem).toHaveBeenCalledTimes(3);

    const persisted = JSON.stringify({ insertedValues, updatedValues });
    expect(persisted).not.toContain("owner@example.com");
    expect(persisted).not.toContain("never-persist-this");
    expect(persisted).not.toContain("Dr Owner");
  });

  it("retries only the CAS after a transient persistence failure", async () => {
    const { db } = databaseDouble({
      updateResults: [new Error("transient"), [acceptedState()]],
      selectResults: [[]],
    });
    mocks.sendVerificationEmailWithProviderEvidence.mockResolvedValue({
      success: true,
      provider: "resend",
      id: "provider-email-1",
      outcome: "accepted",
    });

    await expect(
      sendTrackedVerificationEmail(trackedInput(db)),
    ).resolves.toMatchObject({ success: true, evidencePersisted: true });
    expect(
      mocks.sendVerificationEmailWithProviderEvidence,
    ).toHaveBeenCalledTimes(1);
  });

  it("returns known acceptance and check-inbox semantics when persistence remains unavailable", async () => {
    const { db } = databaseDouble({
      updateResults: [new Error("db down"), new Error("db still down")],
      selectResults: [new Error("read down")],
    });
    mocks.sendVerificationEmailWithProviderEvidence.mockResolvedValue({
      success: true,
      provider: "resend",
      id: "provider-email-1",
      outcome: "accepted",
    });

    await expect(
      sendTrackedVerificationEmail(trackedInput(db)),
    ).resolves.toMatchObject({
      success: true,
      outcome: "accepted",
      possiblySent: false,
      evidencePersisted: false,
    });
    expect(
      mocks.sendVerificationEmailWithProviderEvidence,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Auth email outcome persistence failed",
      expect.not.stringMatching(/owner|token|provider-email-1/i),
    );
  });

  it("reports an unknown provider outcome as possibly sent, never retry-now", async () => {
    const unknownState = {
      outcome: "outcome_unknown",
      provider: "resend",
      providerMessageId: null,
      failureCode: "send_timeout",
    };
    const { db } = databaseDouble({ updateResults: [[unknownState]] });
    mocks.sendVerificationEmailWithProviderEvidence.mockResolvedValue({
      success: false,
      provider: "resend",
      outcome: "outcome_unknown",
      failureCode: "send_timeout",
    });

    const result = await sendTrackedVerificationEmail(trackedInput(db));

    expect(result).toMatchObject({
      success: false,
      outcome: "outcome_unknown",
      possiblySent: true,
      evidencePersisted: true,
    });
    expect(result.error).toMatch(/may have been sent/i);
    expect(result.error).not.toMatch(/try again|retry/i);
  });

  it("models local console acceptance without expecting Resend delivery", async () => {
    mocks.verificationEmailProvider.mockReturnValue("console");
    const { db, insertedValues } = databaseDouble({
      updateResults: [[acceptedState("console", "dev-console:attempt")]],
    });
    mocks.sendVerificationEmailWithProviderEvidence.mockResolvedValue({
      success: true,
      provider: "console",
      id: "dev-console:attempt",
      outcome: "accepted",
    });

    await expect(
      sendTrackedVerificationEmail(trackedInput(db)),
    ).resolves.toMatchObject({
      success: true,
      provider: "console",
      evidencePersisted: true,
    });
    expect(insertedValues[0]).toMatchObject({ provider: "console" });
    expect(mocks.withSystem).toHaveBeenCalledTimes(2);
  });

  it("does not call the provider when reservation commit fails", async () => {
    const { db } = databaseDouble({ insertErrorAtCall: 1 });

    await expect(
      sendTrackedVerificationEmail(trackedInput(db)),
    ).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      possiblySent: false,
      evidencePersisted: false,
    });
    expect(
      mocks.sendVerificationEmailWithProviderEvidence,
    ).not.toHaveBeenCalled();
  });

  it("surfaces signed delivery evidence that disagrees with the provider result", async () => {
    const { db } = databaseDouble({
      updateResults: [[acceptedState()]],
      selectResults: [[{ id: "mismatch-event" }]],
    });
    mocks.sendVerificationEmailWithProviderEvidence.mockResolvedValue({
      success: true,
      provider: "resend",
      id: "provider-email-1",
      outcome: "accepted",
    });

    await expect(
      sendTrackedVerificationEmail(trackedInput(db)),
    ).resolves.toMatchObject({
      success: true,
      identityConflict: true,
      evidencePersisted: false,
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Auth email provider identity conflict",
      expect.any(String),
    );
  });
});

describe("auth verification delivery evidence", () => {
  const attemptId = "00000000-0000-4000-8000-000000000010";
  const rawBody = '{"type":"email.delivered"}';
  const fingerprint = authEmailWebhookFingerprint(rawBody);

  function recordInput(db: unknown, event = webhookEvent()) {
    return {
      event,
      webhookId: "svix-event-1",
      rawBodyFingerprint: fingerprint,
      db: db as never,
    };
  }

  it("computes a lowercase verified-raw-body SHA-256 fingerprint", () => {
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toBe(
      "535799124c18a17be0d968d1622289e68ac38bcb476da8a6532d9e4f256b7c0b",
    );
  });

  it("links an early out-of-order tag callback without racing provider resolution", async () => {
    const { db, insertedValues, updateSet } = databaseDouble({
      selectResults: [
        [],
        [
          {
            id: attemptId,
            createdAt: new Date(),
            outcome: "reserved",
            provider: "resend",
            providerMessageId: null,
          },
        ],
        [],
      ],
    });

    const result = await recordAuthEmailDeliveryEvent(
      recordInput(
        db,
        webhookEvent({
          tags: {
            openvpm_attempt_id: attemptId,
            openvpm_email_kind: "auth_verification",
          },
        }),
      ),
    );

    expect(result).toEqual({
      tracked: true,
      duplicate: false,
      conflict: false,
      attribution: "attempt_tag",
    });
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertedValues[0]).toMatchObject({
      rawBodyFingerprint: fingerprint,
      providerMessageId: "provider-email-1",
      attemptId,
      attribution: "attempt_tag",
    });
    const persisted = JSON.stringify(insertedValues[0]);
    expect(persisted).not.toContain("owner@example.com");
    expect(persisted).not.toContain("Verify your OpenVPM email");
    expect(persisted).not.toContain("openvpm_attempt_id");
  });

  it("repairs a stale reserved attempt from a consistent signed tag", async () => {
    const { db, updateSet } = databaseDouble({
      selectResults: [
        [],
        [
          {
            id: attemptId,
            createdAt: new Date(
              Date.now() - AUTH_EMAIL_WEBHOOK_REPAIR_MIN_AGE_MS - 1_000,
            ),
            outcome: "reserved",
            provider: "resend",
            providerMessageId: null,
          },
        ],
        [],
      ],
    });

    await recordAuthEmailDeliveryEvent(
      recordInput(
        db,
        webhookEvent({
          tags: { openvpm_attempt_id: attemptId },
        }),
      ),
    );

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "accepted",
        providerMessageId: "provider-email-1",
        failureCode: null,
      }),
    );
  });

  it("falls back to the exact Resend message id when tags are absent", async () => {
    const { db, insertedValues } = databaseDouble({
      selectResults: [[], [{ id: attemptId }]],
    });

    await expect(
      recordAuthEmailDeliveryEvent(recordInput(db)),
    ).resolves.toMatchObject({
      tracked: true,
      attribution: "provider_message_id",
    });
    expect(insertedValues[0]).toMatchObject({
      attemptId,
      attribution: "provider_message_id",
    });
  });

  it("deduplicates only the exact same Svix id and fingerprint", async () => {
    const existing = {
      rawBodyFingerprint: fingerprint,
      provider: "resend",
      providerMessageId: "provider-email-1",
      eventType: "email.delivered",
      attribution: "attempt_tag",
    };
    const { db, insertedValues } = databaseDouble({
      selectResults: [[existing]],
    });

    await expect(
      recordAuthEmailDeliveryEvent(recordInput(db)),
    ).resolves.toEqual({
      tracked: true,
      duplicate: true,
      conflict: false,
      attribution: "attempt_tag",
    });
    expect(insertedValues).toEqual([]);
  });

  it("surfaces the same Svix id with a changed fingerprint as a PHI-free conflict", async () => {
    const existing = {
      rawBodyFingerprint: "0".repeat(64),
      provider: "resend",
      providerMessageId: "provider-email-1",
      eventType: "email.delivered",
      attribution: "attempt_tag",
    };
    const { db } = databaseDouble({ selectResults: [[existing]] });

    await expect(
      recordAuthEmailDeliveryEvent(recordInput(db)),
    ).resolves.toEqual({
      tracked: true,
      duplicate: false,
      conflict: true,
      attribution: "identity_conflict",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Auth email webhook identity conflict",
      expect.not.stringMatching(/owner|provider-email-1|subject/i),
    );
  });

  it("race-safely re-reads a winning exact insert before claiming duplicate", async () => {
    const existing = {
      rawBodyFingerprint: fingerprint,
      provider: "resend",
      providerMessageId: "provider-email-1",
      eventType: "email.delivered",
      attribution: "attempt_tag",
    };
    const { db } = databaseDouble({
      selectResults: [
        [],
        [
          {
            id: attemptId,
            createdAt: new Date(),
            outcome: "reserved",
            provider: "resend",
            providerMessageId: null,
          },
        ],
        [],
        [existing],
      ],
      deliveryInsertResults: [[]],
    });

    await expect(
      recordAuthEmailDeliveryEvent(
        recordInput(
          db,
          webhookEvent({ tags: { openvpm_attempt_id: attemptId } }),
        ),
      ),
    ).resolves.toMatchObject({ duplicate: true, conflict: false });
  });

  it("race-safely reports a winning insert with changed identity as conflict", async () => {
    const racedIdentity = {
      rawBodyFingerprint: "0".repeat(64),
      provider: "resend",
      providerMessageId: "different-provider-message",
      eventType: "email.failed",
      attribution: "attempt_tag",
    };
    const { db } = databaseDouble({
      selectResults: [
        [],
        [
          {
            id: attemptId,
            createdAt: new Date(),
            outcome: "reserved",
            provider: "resend",
            providerMessageId: null,
          },
        ],
        [],
        [racedIdentity],
      ],
      deliveryInsertResults: [[]],
    });

    await expect(
      recordAuthEmailDeliveryEvent(
        recordInput(
          db,
          webhookEvent({ tags: { openvpm_attempt_id: attemptId } }),
        ),
      ),
    ).resolves.toMatchObject({ duplicate: false, conflict: true });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Auth email webhook identity conflict",
      expect.any(String),
    );
  });

  it("quarantines conflicting tag and provider identities", async () => {
    const { db, insertedValues } = databaseDouble({
      selectResults: [
        [],
        [
          {
            id: attemptId,
            createdAt: new Date(),
            outcome: "accepted",
            provider: "resend",
            providerMessageId: "different-provider-id",
          },
        ],
        [],
      ],
    });

    await expect(
      recordAuthEmailDeliveryEvent(
        recordInput(
          db,
          webhookEvent({ tags: { openvpm_attempt_id: attemptId } }),
        ),
      ),
    ).resolves.toMatchObject({
      tracked: true,
      conflict: true,
      attribution: "identity_conflict",
    });
    expect(insertedValues[0]).toMatchObject({
      attemptId: null,
      attribution: "identity_conflict",
    });
  });

  it("leaves ordinary client-email events to the communication path", async () => {
    const { db, insertedValues } = databaseDouble({ selectResults: [[], []] });

    await expect(
      recordAuthEmailDeliveryEvent(recordInput(db)),
    ).resolves.toEqual({
      tracked: false,
      duplicate: false,
      conflict: false,
      attribution: null,
    });
    expect(insertedValues).toEqual([]);
  });

  it("classifies redacted events without treating opens/clicks as verification", () => {
    expect(authEmailDeliveryClassification("email.delivered")).toBe(
      "delivered",
    );
    expect(authEmailDeliveryClassification("email.opened")).toBe("opened");
    expect(authEmailDeliveryClassification("email.clicked")).toBe("clicked");
    expect(authEmailDeliveryClassification("email.bounced")).toBe("failed");
  });
});
