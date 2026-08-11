import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USAGE_SOURCE = readFileSync(
  new URL("../usage.ts", import.meta.url),
  "utf8"
);

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];

  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const updateWhere = vi.fn(async (_condition: unknown) => undefined);
  const updateSet = vi.fn((_values: unknown) => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const insertReturning = vi.fn(async () => [{ id: "usage-held" }]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const tx = { select, update, insert };

  return {
    selectResults,
    tx,
    updateSet,
    updateWhere,
    insertValues,
    billingEnforced: vi.fn(() => true),
    recordMeterEvent: vi.fn(async () => true),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: {},
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("../plans", () => ({
  billingEnforced: mocks.billingEnforced,
}));

vi.mock("../stripe-meters", () => ({
  recordMeterEvent: mocks.recordMeterEvent,
}));

const { reconcileUnmeteredUsage, recordUsage } = await import("../usage");

beforeEach(() => {
  mocks.billingEnforced.mockReturnValue(true);
  mocks.recordMeterEvent.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
});

describe("reconcileUnmeteredUsage", () => {
  it("records held usage locally without calling the Stripe meter", async () => {
    mocks.selectResults.push([
      [{ id: "practice-held", recoveryHold: true }],
    ]);

    await expect(
      recordUsage({ practiceId: "practice-held", kind: "ai_run" }),
    ).resolves.toBeUndefined();

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: "practice-held",
        kind: "ai_run",
      }),
    );
    expect(mocks.recordMeterEvent).not.toHaveBeenCalled();
  });

  it("does not query usage records when hosted billing is disabled", async () => {
    mocks.billingEnforced.mockReturnValue(false);

    await expect(reconcileUnmeteredUsage()).resolves.toEqual({
      attempted: 0,
      metered: 0,
      skipped: 0,
    });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.recordMeterEvent).not.toHaveBeenCalled();
  });

  it("selects only active customer-backed rows for reconciliation batches", async () => {
    mocks.selectResults.push(
      [
        {
          id: "usage-with-customer",
          practiceId: "practice-with-customer",
          kind: "ai_run",
          quantity: 2,
        },
      ],
      [{ stripeCustomerId: "cus_123" }]
    );

    await expect(reconcileUnmeteredUsage({ limit: 2 })).resolves.toEqual({
      attempted: 1,
      metered: 1,
      skipped: 0,
    });
    expect(mocks.recordMeterEvent).toHaveBeenCalledTimes(1);
    expect(mocks.recordMeterEvent).toHaveBeenCalledWith({
      kind: "ai_run",
      stripeCustomerId: "cus_123",
      value: 2,
      identifier: "usage:usage-with-customer",
    });
    expect(mocks.updateSet).toHaveBeenCalledWith({
      stripeMeterIdentifier: "usage:usage-with-customer",
      stripeMeteredAt: expect.any(Date),
    });
    expect(USAGE_SOURCE).toContain(".innerJoin(");
    expect(USAGE_SOURCE).toContain("isNotNull(practices.stripeCustomerId)");
  });

  it("leaves Stripe failures retryable instead of counting them as skipped", async () => {
    mocks.recordMeterEvent.mockResolvedValueOnce(false);
    mocks.selectResults.push(
      [
        {
          id: "usage-failed",
          practiceId: "practice-with-customer",
          kind: "sms",
          quantity: 1,
        },
      ],
      [{ stripeCustomerId: "cus_123" }]
    );

    await expect(reconcileUnmeteredUsage({ limit: 1 })).resolves.toEqual({
      attempted: 1,
      metered: 0,
      skipped: 0,
    });
    expect(mocks.recordMeterEvent).toHaveBeenCalledWith({
      kind: "sms",
      stripeCustomerId: "cus_123",
      value: 1,
      identifier: "usage:usage-failed",
    });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
