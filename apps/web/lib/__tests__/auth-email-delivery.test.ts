import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let systemDepth = 0;
  return {
    get systemDepth() {
      return systemDepth;
    },
    sendVerificationEmailWithProviderEvidence: vi.fn(),
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

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/email", () => ({
  sendVerificationEmailWithProviderEvidence:
    mocks.sendVerificationEmailWithProviderEvidence,
}));

const {
  authEmailDeliveryClassification,
  recordAuthEmailDeliveryEvent,
  sendTrackedVerificationEmail,
} = await import("../auth-email-delivery");

function databaseDouble(options?: {
  selectResults?: unknown[][];
  deliveryInsertResults?: unknown[][];
  updateResults?: unknown[][];
}) {
  const selectResults = [...(options?.selectResults ?? [])];
  const deliveryInsertResults = [...(options?.deliveryInsertResults ?? [])];
  const updateResults = [...(options?.updateResults ?? [[{ id: "recorded" }]])];
  const insertedValues: unknown[] = [];
  const updatedValues: unknown[] = [];

  const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertReturning = vi.fn(
    async () => deliveryInsertResults.shift() ?? [{ id: "event-recorded" }],
  );
  const onConflictDoNothing = vi.fn(() => ({ returning: insertReturning }));
  const insertValues = vi.fn((values: unknown) => {
    insertedValues.push(values);
    return { onConflictDoNothing };
  });
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => updateResults.shift() ?? []);
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("tracked verification email dispatch", () => {
  it("reserves before the provider call, sends outside the transaction, and records acceptance", async () => {
    const { db, insertedValues, updatedValues } = databaseDouble();
    mocks.sendVerificationEmailWithProviderEvidence.mockImplementation(
      async (payload: Record<string, unknown>) => {
        expect(mocks.systemDepth).toBe(0);
        expect(insertedValues).toHaveLength(1);
        expect(payload.attemptId).toMatch(/^[0-9a-f-]{36}$/);
        expect(payload.idempotencyKey).toBe(
          `auth-email:${String(payload.attemptId)}`,
        );
        return {
          success: true,
          id: "provider-email-1",
          outcome: "accepted",
        };
      },
    );

    const result = await sendTrackedVerificationEmail({
      practiceId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      source: "registration",
      to: "owner@example.com",
      name: "Dr Owner",
      verifyUrl:
        "https://app.openvpm.com/verify-email?token=never-persist-this",
      db: db as never,
    });

    expect(result).toMatchObject({
      success: true,
      outcome: "accepted",
      providerMessageId: "provider-email-1",
    });
    expect(insertedValues[0]).toMatchObject({
      practiceId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      source: "registration",
      idempotencyKey: `auth-email:${result.attemptId}`,
    });
    expect(updatedValues).toEqual([
      expect.objectContaining({
        outcome: "accepted",
        providerMessageId: "provider-email-1",
        failureCode: null,
      }),
    ]);

    const persisted = JSON.stringify({ insertedValues, updatedValues });
    expect(persisted).not.toContain("owner@example.com");
    expect(persisted).not.toContain("never-persist-this");
    expect(persisted).not.toContain("Dr Owner");
  });

  it.each([
    {
      outcome: "definite_failure",
      failureCode: "provider_rejected",
    },
    {
      outcome: "outcome_unknown",
      failureCode: "send_timeout",
    },
  ] as const)(
    "records $outcome without provider identity",
    async (expected) => {
      const { db, updatedValues } = databaseDouble();
      mocks.sendVerificationEmailWithProviderEvidence.mockResolvedValue({
        success: false,
        error: "provider detail shown only to the request",
        ...expected,
      });

      const result = await sendTrackedVerificationEmail({
        practiceId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000002",
        source: "authenticated_resend",
        to: "owner@example.com",
        name: "Dr Owner",
        verifyUrl: "https://app.openvpm.com/verify-email?token=secret",
        db: db as never,
      });

      expect(result.outcome).toBe(expected.outcome);
      expect(updatedValues[0]).toMatchObject({
        outcome: expected.outcome,
        providerMessageId: null,
        failureCode: expected.failureCode,
      });
      expect(JSON.stringify(updatedValues)).not.toContain("provider detail");
    },
  );

  it("fails loudly when the reserved provider outcome cannot be persisted", async () => {
    const { db } = databaseDouble({ updateResults: [[]] });
    mocks.sendVerificationEmailWithProviderEvidence.mockResolvedValue({
      success: true,
      id: "provider-email-1",
      outcome: "accepted",
    });

    await expect(
      sendTrackedVerificationEmail({
        practiceId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000002",
        source: "registration",
        to: "owner@example.com",
        name: "Dr Owner",
        verifyUrl: "https://app.openvpm.com/verify-email?token=secret",
        db: db as never,
      }),
    ).rejects.toThrow(
      "Verification email provider outcome could not be recorded safely.",
    );
  });
});

describe("auth verification delivery evidence", () => {
  const attemptId = "00000000-0000-4000-8000-000000000010";

  it("attributes an out-of-order callback by its attempt tag", async () => {
    const { db, insertedValues } = databaseDouble({
      selectResults: [[{ id: attemptId, providerMessageId: null }], []],
    });

    const result = await recordAuthEmailDeliveryEvent({
      event: webhookEvent({
        tags: {
          openvpm_attempt_id: attemptId,
          openvpm_email_kind: "auth_verification",
        },
      }),
      webhookId: "svix-out-of-order",
      db: db as never,
    });

    expect(result).toEqual({
      tracked: true,
      duplicate: false,
      attribution: "attempt_tag",
    });
    expect(insertedValues[0]).toMatchObject({
      webhookId: "svix-out-of-order",
      providerMessageId: "provider-email-1",
      attemptId,
      eventType: "email.delivered",
      classification: "delivered",
      attribution: "attempt_tag",
    });
    const persisted = JSON.stringify(insertedValues[0]);
    expect(persisted).not.toContain("owner@example.com");
    expect(persisted).not.toContain("Verify your OpenVPM email");
    expect(persisted).not.toContain("openvpm_attempt_id");
  });

  it("falls back to the exact provider message id when tags are absent", async () => {
    const { db, insertedValues } = databaseDouble({
      selectResults: [[{ id: attemptId }]],
    });

    await expect(
      recordAuthEmailDeliveryEvent({
        event: webhookEvent(),
        webhookId: "svix-provider-fallback",
        db: db as never,
      }),
    ).resolves.toMatchObject({
      tracked: true,
      attribution: "provider_message_id",
    });
    expect(insertedValues[0]).toMatchObject({
      attemptId,
      attribution: "provider_message_id",
    });
  });

  it("quarantines conflicting tag and provider identities", async () => {
    const { db, insertedValues } = databaseDouble({
      selectResults: [
        [{ id: attemptId, providerMessageId: "different-provider-id" }],
        [],
      ],
    });

    await expect(
      recordAuthEmailDeliveryEvent({
        event: webhookEvent({
          tags: {
            openvpm_attempt_id: attemptId,
            openvpm_email_kind: "auth_verification",
          },
        }),
        webhookId: "svix-conflict",
        db: db as never,
      }),
    ).resolves.toEqual({
      tracked: true,
      duplicate: false,
      attribution: "identity_conflict",
    });
    expect(insertedValues[0]).toMatchObject({
      attemptId: null,
      attribution: "identity_conflict",
    });
  });

  it("deduplicates redelivery by the signed Svix id", async () => {
    const { db, onConflictDoNothing } = databaseDouble({
      selectResults: [[{ id: attemptId, providerMessageId: null }], []],
      deliveryInsertResults: [[]],
    });

    await expect(
      recordAuthEmailDeliveryEvent({
        event: webhookEvent({
          tags: { openvpm_attempt_id: attemptId },
        }),
        webhookId: "svix-duplicate",
        db: db as never,
      }),
    ).resolves.toMatchObject({ tracked: true, duplicate: true });
    expect(onConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.anything() }),
    );
  });

  it("leaves ordinary client-email events to the existing communication path", async () => {
    const { db, insertedValues } = databaseDouble({ selectResults: [[]] });

    await expect(
      recordAuthEmailDeliveryEvent({
        event: webhookEvent(),
        webhookId: "svix-client-email",
        db: db as never,
      }),
    ).resolves.toEqual({
      tracked: false,
      duplicate: false,
      attribution: null,
    });
    expect(insertedValues).toEqual([]);
  });

  it("classifies delivery events independently of arrival order", () => {
    expect(authEmailDeliveryClassification("email.delivered")).toBe(
      "delivered",
    );
    expect(authEmailDeliveryClassification("email.sent")).toBe("sent");
    expect(authEmailDeliveryClassification("email.delivery_delayed")).toBe(
      "delayed",
    );
    expect(authEmailDeliveryClassification("email.bounced")).toBe("failed");
    expect(authEmailDeliveryClassification("email.complained")).toBe(
      "complained",
    );
  });
});
