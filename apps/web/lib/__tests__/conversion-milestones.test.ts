import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystem: vi.fn(
    async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(database),
  ),
}));

vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));

const {
  projectActivationMilestone,
  recordActivationAfterClientCreated,
  reconcileConversionMilestones,
  upsertPracticeConversionMilestone,
} = await import("@/lib/conversion-milestones");

afterEach(() => {
  vi.clearAllMocks();
});

function insertDb(returned: unknown[] = [{ practiceId: "practice-1" }]) {
  const returning = vi.fn(async () => returned);
  const onConflictDoUpdate = vi.fn((_input: unknown) => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  return {
    db: { insert: vi.fn(() => ({ values })) },
    values,
    onConflictDoUpdate,
  };
}

describe("canonical conversion milestones", () => {
  it("upserts exact evidence while preserving first observation time", async () => {
    const { db, values, onConflictDoUpdate } = insertDb();
    const occurredAt = new Date("2026-08-02T03:04:05.000Z");

    await expect(
      upsertPracticeConversionMilestone(db as never, {
        practiceId: "00000000-0000-0000-0000-000000000001",
        milestone: "first_positive_payment",
        occurredAt,
        evidenceSource: "stripe_webhook",
        evidenceKey: "stripe:evt_paid",
        amountCents: 7900,
        currency: "usd",
      }),
    ).resolves.toBe(true);

    expect(values).toHaveBeenCalledWith({
      practiceId: "00000000-0000-0000-0000-000000000001",
      milestone: "first_positive_payment",
      occurredAt,
      evidenceSource: "stripe_webhook",
      evidenceKey: "stripe:evt_paid",
      amountCents: 7900,
      currency: "usd",
    });
    const update = onConflictDoUpdate.mock.calls[0]![0] as {
      set: Record<string, unknown>;
      setWhere: unknown;
    };
    expect(update.set).not.toHaveProperty("observedAt");
    expect(update.setWhere).toBeTruthy();
  });

  it("uses the later exact source time and stable product ids for activation", async () => {
    const { db: insertOnly, values } = insertDb();
    const db = {
      ...insertOnly,
      execute: vi.fn(async () => [
        {
          practiceId: "00000000-0000-0000-0000-000000000001",
          practiceCreatedAt: "2026-08-01T00:00:00.000Z",
          clientId: "00000000-0000-0000-0000-000000000002",
          clientCreatedAt: "2026-08-02T00:00:00.000Z",
          appointmentId: "00000000-0000-0000-0000-000000000003",
          appointmentCreatedAt: "2026-08-03T00:00:00.000Z",
        },
      ]),
    };

    await expect(
      projectActivationMilestone(
        db as never,
        "00000000-0000-0000-0000-000000000001",
      ),
    ).resolves.toBe(true);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        milestone: "activated",
        occurredAt: new Date("2026-08-03T00:00:00.000Z"),
        evidenceSource: "product_records",
        evidenceKey:
          "client:00000000-0000-0000-0000-000000000002|appointment:00000000-0000-0000-0000-000000000003",
      }),
    );
  });

  it("never makes a committed product action fail on projection telemetry", async () => {
    const error = new Error("database unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const db = { execute: vi.fn(async () => Promise.reject(error)) };

    await expect(
      recordActivationAfterClientCreated(
        db as never,
        "00000000-0000-0000-0000-000000000001",
        "clients.create",
      ),
    ).resolves.toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "[clients.create] activation milestone projection failed:",
      error,
    );
    consoleError.mockRestore();
  });

  it("reconciles all four stages from local evidence only", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ practiceId: "registration" }])
      .mockResolvedValueOnce([{ practiceId: "activation" }])
      .mockResolvedValueOnce([{ practiceId: "payment-method" }])
      .mockResolvedValueOnce([{ practiceId: "positive-payment" }]);

    await expect(
      reconcileConversionMilestones({ execute } as never),
    ).resolves.toEqual({
      registrationsRepaired: 1,
      activationsRepaired: 1,
      paymentMethodsRepaired: 1,
      positivePaymentsRepaired: 1,
    });
    expect(execute).toHaveBeenCalledTimes(4);

    const source = readFileSync("lib/conversion-milestones.ts", "utf8");
    expect(source).toContain("from stripe_events se");
    expect(source).not.toContain("stripe.subscriptions");
    expect(source).not.toContain("from funnel_events");
    expect(source).not.toContain("billing_status = 'active'");
    expect(source).not.toContain("practices.updated_at");
  });
});
