import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const executeResults: unknown[][] = [];
  const execute = vi.fn(async () => executeResults.shift() ?? []);
  const db = { execute };

  return {
    db,
    execute,
    executeResults,
    withTenant: vi.fn(
      async (
        database: unknown,
        _practiceId: string,
        fn: (tx: unknown) => Promise<unknown>
      ) => fn(database)
    ),
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn(database)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withTenant: mocks.withTenant,
  withSystem: mocks.withSystem,
}));

const { adminRouter } = await import("../routers/admin");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function caller(email = "ops@example.com") {
  return adminRouter.createCaller({
    db: mocks.db,
    session: {
      user: {
        id: USER_ID,
        email,
        name: "Ops",
        role: "admin",
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.executeResults.length = 0;
});

describe("admin activation funnel", () => {
  it("rejects non-platform-admin callers with FORBIDDEN", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");

    await expect(
      caller("clinic-admin@example.com").activationFunnel({ days: 30 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects non-platform-admin activation recovery callers", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");

    await expect(
      caller("clinic-admin@example.com").activationRecovery()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("sums weekly rows and computes activation and conversion rates", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.executeResults.push([
      { weekStart: "2026-06-15", signups: 4, setupStarted: 3, setupCompleted: 1, activated: 2, firstVisitCompleted: 1, paymentMethodCollected: 2, firstPositivePayment: 1, currentlyActive: 1 },
      { weekStart: "2026-06-22", signups: 6, setupStarted: 4, setupCompleted: 2, activated: 3, firstVisitCompleted: 2, paymentMethodCollected: 3, firstPositivePayment: 2, currentlyActive: 2 },
    ], [{ legacyBusinessStageRows: 9, unknownPaymentMethodPractices: 2 }]);

    const result = await caller().activationFunnel({ days: 30 });

    expect(result.days).toBe(30);
    expect(result.weeks).toEqual([
      { weekStart: "2026-06-15", signups: 4, setupStarted: 3, setupCompleted: 1, activated: 2, firstVisitCompleted: 1, paymentMethodCollected: 2, firstPositivePayment: 1, currentlyActive: 1 },
      { weekStart: "2026-06-22", signups: 6, setupStarted: 4, setupCompleted: 2, activated: 3, firstVisitCompleted: 2, paymentMethodCollected: 3, firstPositivePayment: 2, currentlyActive: 2 },
    ]);
    expect(result.totals).toEqual({
      signups: 10,
      setupStarted: 7,
      setupCompleted: 3,
      activated: 5,
      firstVisitCompleted: 3,
      paymentMethodCollected: 5,
      firstPositivePayment: 3,
      currentlyActive: 3,
      setupStartRate: 0.7,
      setupCompletionRate: 0.3,
      activationRate: 0.5,
      firstVisitCompletionRate: 0.6,
      paymentMethodRate: 1,
      positivePaymentRate: 0.6,
      currentlyActiveRate: 0.3,
    });
    expect(result.dataQuality).toMatchObject({
      legacyBusinessStageRows: 9,
      unknownPaymentMethodPractices: 2,
    });
    expect(mocks.withSystem).toHaveBeenCalledWith(
      mocks.db,
      expect.any(Function)
    );
  });

  it("defaults to a 30-day window when no input is given", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.executeResults.push([], []);

    const result = await caller().activationFunnel();

    expect(result.days).toBe(30);
  });

  it("returns zero rates instead of dividing by zero when there are no signups", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.executeResults.push([], []);

    const result = await caller().activationFunnel({ days: 7 });

    expect(result.totals).toEqual({
      signups: 0,
      setupStarted: 0,
      setupCompleted: 0,
      activated: 0,
      firstVisitCompleted: 0,
      paymentMethodCollected: 0,
      firstPositivePayment: 0,
      currentlyActive: 0,
      setupStartRate: 0,
      setupCompletionRate: 0,
      activationRate: 0,
      firstVisitCompletionRate: 0,
      paymentMethodRate: 0,
      positivePaymentRate: 0,
      currentlyActiveRate: 0,
    });
  });

  it("coerces string counts from the driver into numbers", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.executeResults.push([
      { weekStart: "2026-06-29", signups: "2", setupStarted: "1", setupCompleted: "0", activated: "1", firstVisitCompleted: "1", paymentMethodCollected: "1", firstPositivePayment: "0", currentlyActive: "0" },
    ], []);

    const result = await caller().activationFunnel({ days: 30 });

    expect(result.totals.signups).toBe(2);
    expect(result.totals.activated).toBe(1);
    expect(result.totals.firstVisitCompleted).toBe(1);
    expect(result.totals.firstVisitCompletionRate).toBe(1);
    expect(result.totals.paymentMethodCollected).toBe(1);
    expect(result.totals.activationRate).toBe(0.5);
  });

  it("uses canonical milestones and reports current billing state separately", () => {
    const source = readFileSync("lib/admin/activation-funnel.ts", "utf8");

    // Demo ids seeded into practices.settings.demoData never count.
    expect(source).toContain("p.settings -> 'demoData' -> 'clientIds'");
    expect(source).toContain("p.settings -> 'demoData' -> 'appointmentIds'");
    // Soft-deleted/test practices are excluded from cohorts.
    expect(source).toContain("p.deleted_at is null");
    expect(source).toContain(
      "p.settings ->> 'analyticsExcluded' is distinct from 'true'"
    );
    expect(source).toContain("from practice_conversion_milestones pcm");
    expect(source).toContain("pcm.milestone = 'activated'");
    expect(source).toContain("pcm.milestone = 'payment_method_collected'");
    expect(source).toContain("pcm.milestone = 'first_positive_payment'");
    expect(source).toContain("onboardingIntentSelectedAt");

    // First-visit completion requires a completed, tenant-owned closeout for a
    // real appointment and uses the same post-signup/demo exclusions.
    expect(source).toContain("from visit_closeouts vc");
    expect(source).toContain("a.practice_id = s.id");
    expect(source).toContain("vc.practice_id = s.id");
    expect(source).toContain("vc.status = 'completed'");
    expect(source).toContain("vc.deleted_at is null");

    // Current active is not used as synthetic historical payment evidence.
    expect(source).toContain("s.billing_status = 'active'");
    expect(source).toContain("unknownPositivePaymentPractices");
    expect(source).toContain("legacyBusinessStageRows");

    // Weekly grouping via date_trunc — a grouped aggregate, not a per-practice N+1.
    expect(source).toContain("date_trunc('week', p.created_at)");
  });
});
