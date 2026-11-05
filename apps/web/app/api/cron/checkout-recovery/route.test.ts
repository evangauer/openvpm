import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const executeResults: unknown[][] = [];
  const execute = vi.fn(async () => executeResults.shift() ?? []);
  const db = { execute };
  return {
    db,
    execute,
    executeResults,
    billingEnforced: vi.fn(() => true),
    cronAuthError: vi.fn(() => null),
    reportCronHeartbeat: vi.fn(async () => undefined),
    alertOps: vi.fn(async () => undefined),
    sendCheckoutRecoveryEmail: vi.fn(async () => ({
      success: true,
      id: "email-checkout",
    })),
    sendOptionalPlatformEmail: vi.fn(
      async (opts: {
        stillEligible?: (tx: unknown) => Promise<boolean>;
        send: () => Promise<{ success: boolean }>;
      }) => {
        if (opts.stillEligible && !(await opts.stillEligible(db))) {
          return { sent: false, deduped: false, suppressed: true };
        }
        const result = await opts.send();
        return result.success
          ? { sent: true, deduped: false }
          : { sent: false, deduped: false };
      },
    ),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
}));
vi.mock("@/lib/cron-auth", () => ({ cronAuthError: mocks.cronAuthError }));
vi.mock("@/lib/cron-heartbeat", () => ({
  reportCronHeartbeat: mocks.reportCronHeartbeat,
}));
vi.mock("@/lib/alerts", () => ({ alertOps: mocks.alertOps }));
vi.mock("@/lib/email", () => ({
  sendCheckoutRecoveryEmail: mocks.sendCheckoutRecoveryEmail,
}));
vi.mock("@/lib/email-lifecycle", () => ({
  sendOptionalPlatformEmail: mocks.sendOptionalPlatformEmail,
}));

const { GET } = await import("./route");

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-11-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    practiceId: PRACTICE_ID,
    practiceName: "Neighborhood Veterinary",
    createdAt: new Date(NOW.getTime() - 2 * HOUR),
    adminEmail: "owner@example.com",
    adminName: "Sam Rivera",
    adminVerified: false,
    existingEmailCount: 0,
    lastEmailAt: null,
    ...overrides,
  };
}

function request() {
  return new Request("https://app.openvpm.com/api/cron/checkout-recovery");
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("CHECKOUT_RECOVERY_ENABLED", "true");
  vi.stubEnv("CHECKOUT_RECOVERY_ROLLOUT_AT", "2026-11-01T00:00:00Z");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.executeResults.length = 0;
  mocks.billingEnforced.mockReturnValue(true);
});

describe("checkout recovery cron", () => {
  it("does nothing until the campaign is enabled with a rollout time", async () => {
    vi.stubEnv("CHECKOUT_RECOVERY_ENABLED", "false");
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      disabled: true,
      reason: "disabled",
      sent: 0,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ job: "checkout-recovery", status: "ok" }),
    );
  });

  it("does nothing on self-hosted deployments", async () => {
    mocks.billingEnforced.mockReturnValue(false);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      disabled: true,
      reason: "billing_disabled",
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("sends the due step with a step-scoped dedupe key", async () => {
    mocks.executeResults.push([candidate()], [{ eligible: 1 }]);

    const response = await GET(request());

    expect(await response.json()).toMatchObject({
      candidates: 1,
      eligible: 1,
      sent: 1,
      failed: 0,
    });
    expect(mocks.sendOptionalPlatformEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        to: "owner@example.com",
        emailType: "checkout-recovery",
        dedupeKey: `lc:checkout-recovery:v1:${PRACTICE_ID}:1`,
        retryOnFail: true,
      }),
    );
    expect(mocks.sendCheckoutRecoveryEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      practiceId: PRACTICE_ID,
      practiceName: "Neighborhood Veterinary",
      adminName: "Sam Rivera",
      step: 1,
      idempotencyKey: `lc:checkout-recovery:v1:${PRACTICE_ID}:1`,
    });
  });

  it("skips clinics whose next step is not due", async () => {
    mocks.executeResults.push([
      candidate({
        existingEmailCount: 1,
        lastEmailAt: new Date(NOW.getTime() - HOUR),
      }),
    ]);

    const response = await GET(request());

    expect(await response.json()).toMatchObject({ skipped: 1, sent: 0 });
    expect(mocks.sendOptionalPlatformEmail).not.toHaveBeenCalled();
  });

  it("suppresses the send when the clinic started a trial meanwhile", async () => {
    mocks.executeResults.push([candidate()], []);

    const response = await GET(request());

    expect(await response.json()).toMatchObject({ suppressed: 1, sent: 0 });
    expect(mocks.sendCheckoutRecoveryEmail).not.toHaveBeenCalled();
  });

  it("reports failures without throwing", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("db down"));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Checkout recovery cron failed",
      "db down",
    );
    expect(mocks.reportCronHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ job: "checkout-recovery", status: "failed" }),
    );
  });
});
