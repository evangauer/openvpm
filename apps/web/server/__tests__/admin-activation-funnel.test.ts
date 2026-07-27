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

  it("sums weekly rows and computes activation and conversion rates", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.executeResults.push([
      { weekStart: "2026-06-15", signups: 4, setupStarted: 3, setupCompleted: 1, activated: 2, billingStarted: 2, subscribed: 1 },
      { weekStart: "2026-06-22", signups: 6, setupStarted: 4, setupCompleted: 2, activated: 3, billingStarted: 4, subscribed: 2 },
    ]);

    const result = await caller().activationFunnel({ days: 30 });

    expect(result.days).toBe(30);
    expect(result.weeks).toEqual([
      { weekStart: "2026-06-15", signups: 4, setupStarted: 3, setupCompleted: 1, activated: 2, billingStarted: 2, subscribed: 1 },
      { weekStart: "2026-06-22", signups: 6, setupStarted: 4, setupCompleted: 2, activated: 3, billingStarted: 4, subscribed: 2 },
    ]);
    expect(result.totals).toEqual({
      signups: 10,
      setupStarted: 7,
      setupCompleted: 3,
      activated: 5,
      billingStarted: 6,
      subscribed: 3,
      setupStartRate: 0.7,
      setupCompletionRate: 0.3,
      activationRate: 0.5,
      billingStartRate: 0.6,
      conversionRate: 0.3,
    });
    expect(mocks.withSystem).toHaveBeenCalledWith(
      mocks.db,
      expect.any(Function)
    );
  });

  it("defaults to a 30-day window when no input is given", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.executeResults.push([]);

    const result = await caller().activationFunnel();

    expect(result.days).toBe(30);
  });

  it("returns zero rates instead of dividing by zero when there are no signups", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.executeResults.push([]);

    const result = await caller().activationFunnel({ days: 7 });

    expect(result.totals).toEqual({
      signups: 0,
      setupStarted: 0,
      setupCompleted: 0,
      activated: 0,
      billingStarted: 0,
      subscribed: 0,
      setupStartRate: 0,
      setupCompletionRate: 0,
      activationRate: 0,
      billingStartRate: 0,
      conversionRate: 0,
    });
  });

  it("coerces string counts from the driver into numbers", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.executeResults.push([
      { weekStart: "2026-06-29", signups: "2", setupStarted: "1", setupCompleted: "0", activated: "1", billingStarted: "1", subscribed: "0" },
    ]);

    const result = await caller().activationFunnel({ days: 30 });

    expect(result.totals.signups).toBe(2);
    expect(result.totals.activated).toBe(1);
    expect(result.totals.billingStarted).toBe(1);
    expect(result.totals.activationRate).toBe(0.5);
  });

  it("excludes demo rows and soft-deleted data in the funnel SQL", () => {
    const source = readFileSync("lib/admin/activation-funnel.ts", "utf8");

    // Demo ids seeded into practices.settings.demoData never count.
    expect(source).toContain("p.settings -> 'demoData' -> 'clientIds'");
    expect(source).toContain("p.settings -> 'demoData' -> 'appointmentIds'");
    expect(source).toContain("not (s.demo_client_ids @> to_jsonb(c.id::text))");
    expect(source).toContain(
      "not (s.demo_appointment_ids @> to_jsonb(a.id::text))"
    );

    // Soft-deleted practices, clients, and appointments are excluded.
    expect(source).toContain("p.deleted_at is null");
    expect(source).toContain(
      "p.settings ->> 'analyticsExcluded' is distinct from 'true'"
    );
    expect(source).toContain("c.deleted_at is null");
    expect(source).toContain("a.deleted_at is null");

    // Activation only counts rows created after the practice signed up.
    expect(source).toContain("c.created_at >= s.created_at");
    expect(source).toContain("a.created_at >= s.created_at");

    // Subscribed means an active subscription, not a running trial.
    expect(source).toContain("where s.billing_status = 'active'");
    expect(source).toContain("s.stripe_subscription_id is not null");
    expect(source).toContain("s.billing_status in ('trialing', 'active')");

    // Weekly grouping via date_trunc — a grouped aggregate, not a per-practice N+1.
    expect(source).toContain("date_trunc('week', p.created_at)");
  });
});
