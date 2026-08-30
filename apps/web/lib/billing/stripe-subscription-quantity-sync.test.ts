import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  db: {},
  claim: vi.fn(),
  resolve: vi.fn(async () => true),
  list: vi.fn(async () => [] as string[]),
  requestPractice: vi.fn(),
  claimPractice: vi.fn(),
  resolvePractice: vi.fn(async () => true),
  listPractices: vi.fn(async () => [] as string[]),
  sync: vi.fn(),
  alertOps: vi.fn(async () => undefined),
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("./subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: mocks.sync,
}));
vi.mock("./stripe-events", () => ({
  claimStripeSubscriptionQuantitySync: mocks.claim,
  resolveStripeSubscriptionQuantitySync: mocks.resolve,
  listRetryableStripeSubscriptionQuantitySyncs: mocks.list,
  requestPracticeSubscriptionQuantitySync: mocks.requestPractice,
  claimPracticeSubscriptionQuantitySync: mocks.claimPractice,
  resolvePracticeSubscriptionQuantitySync: mocks.resolvePractice,
  listRetryablePracticeSubscriptionQuantitySyncs: mocks.listPractices,
}));

const {
  requestAndRunPracticeSubscriptionQuantitySync,
  runDurablePracticeSubscriptionQuantitySync,
  runDurableSubscriptionQuantitySync,
} = await import("./stripe-subscription-quantity-sync");

const SOURCE = readFileSync(
  new URL("./stripe-subscription-quantity-sync.ts", import.meta.url),
  "utf8",
);
const SETTINGS_SOURCE = readFileSync(
  new URL("../../server/routers/settings.ts", import.meta.url),
  "utf8",
);

afterEach(() => {
  vi.clearAllMocks();
});

describe("durable Stripe subscription quantity sync", () => {
  it("persists retry evidence and resumes with a stable provider identity", async () => {
    mocks.claim.mockResolvedValue({
      state: "claimed",
      job: {
        eventId: "evt_quantity",
        practiceId: "practice-1",
        subscriptionId: "sub_1",
        leaseToken: "lease-1",
        leaseExpiresAt: new Date("2026-07-01T00:05:00Z"),
      },
    });
    mocks.sync
      .mockResolvedValueOnce({ status: "error", message: "timeout" })
      .mockResolvedValueOnce({ status: "ok", message: "synced" });

    await expect(
      runDurableSubscriptionQuantitySync("evt_quantity"),
    ).resolves.toBe(false);
    expect(mocks.resolve).toHaveBeenNthCalledWith(
      1,
      {},
      {
        eventId: "evt_quantity",
        leaseToken: "lease-1",
        outcome: "retry",
      },
    );
    const firstKey = mocks.sync.mock.calls[0]?.[0].idempotencyKeyPrefix;

    await expect(
      runDurableSubscriptionQuantitySync("evt_quantity"),
    ).resolves.toBe(true);
    expect(mocks.resolve).toHaveBeenNthCalledWith(
      2,
      {},
      {
        eventId: "evt_quantity",
        leaseToken: "lease-1",
        outcome: "completed",
      },
    );
    expect(firstKey).toBe("stripe-event:evt_quantity");
    expect(mocks.sync.mock.calls[1]?.[0].idempotencyKeyPrefix).toBe(firstKey);
  });

  it("keeps provider I/O outside both claim and outcome transactions", async () => {
    let transactionOpen = false;
    mocks.withSystem.mockImplementation(async (_db, fn) => {
      transactionOpen = true;
      try {
        return await fn({});
      } finally {
        transactionOpen = false;
      }
    });
    mocks.claim.mockResolvedValue({
      state: "claimed",
      job: {
        eventId: "evt_quantity",
        practiceId: "practice-1",
        subscriptionId: "sub_1",
        leaseToken: "lease-1",
        leaseExpiresAt: new Date("2026-07-01T00:05:00Z"),
      },
    });
    mocks.sync.mockImplementation(async () => {
      expect(transactionOpen).toBe(false);
      return { status: "ok", message: "synced" };
    });

    await expect(
      runDurableSubscriptionQuantitySync("evt_quantity"),
    ).resolves.toBe(true);
    expect(mocks.withSystem).toHaveBeenCalledTimes(2);
  });

  it("preserves a local request behind another durable lease", async () => {
    mocks.requestPractice.mockResolvedValue(true);
    mocks.claimPractice.mockResolvedValue({ state: "busy" });

    await expect(
      requestAndRunPracticeSubscriptionQuantitySync("practice-1"),
    ).resolves.toBe(false);
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.resolvePractice).not.toHaveBeenCalled();
  });

  it("uses the immutable request revision in local provider idempotency", async () => {
    const leaseExpiresAt = new Date("2026-07-01T00:05:00Z");
    mocks.claimPractice.mockResolvedValue({
      state: "claimed",
      job: {
        practiceId: "practice-1",
        subscriptionId: "sub_1",
        requestedRevision: 7,
        leaseToken: "lease-local",
        leaseExpiresAt,
      },
    });
    mocks.sync.mockResolvedValue({ status: "ok", message: "synced" });

    await expect(
      runDurablePracticeSubscriptionQuantitySync("practice-1"),
    ).resolves.toBe(true);
    expect(mocks.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseToken: "lease-local",
        leaseExpiresAt,
        idempotencyKeyPrefix:
          "practice:practice-1:subscription:sub_1:revision:7",
      }),
    );
  });

  it("routes settings mutations through post-commit durable requests", () => {
    expect(SETTINGS_SOURCE).not.toContain(
      "syncPracticeSubscriptionQuantities({",
    );
    expect(SETTINGS_SOURCE).toMatch(
      /postCommitEffect\(async \(rootDb\) => \{[\s\S]+requestAndRunPracticeSubscriptionQuantitySync\(practiceId, rootDb\)/,
    );
    expect(SOURCE).toContain("idempotencyKeyPrefix: `stripe-event:${eventId}`");
  });
});
