import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(async () => result),
      groupBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const updateSet = vi.fn();
  const update = vi.fn(() => ({
    set: vi.fn((values: unknown) => {
      updateSet(values);
      return { where: vi.fn(async () => undefined) };
    }),
  }));
  const db = { select, update, execute: vi.fn(async () => undefined) };

  return {
    db,
    selectResults,
    update,
    updateSet,
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
vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

const { adminRouter } = await import("../routers/admin");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const DAY_MS = 24 * 60 * 60 * 1000;

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
  mocks.selectResults.length = 0;
});

describe("admin extendTrial", () => {
  it("extends an active trial from its current end date", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    const currentEnd = new Date(Date.now() + 3 * DAY_MS);
    mocks.selectResults.push([
      {
        id: PRACTICE_ID,
        billingStatus: "trialing",
        trialEndsAt: currentEnd,
      },
    ]);

    const result = await caller().extendTrial({
      practiceId: PRACTICE_ID,
      days: 14,
    });

    expect(result.trialEndsAt.getTime()).toBe(
      currentEnd.getTime() + 14 * DAY_MS
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ trialEndsAt: result.trialEndsAt })
    );
    expect(mocks.withSystem).toHaveBeenCalled();
  });

  it("revives a lapsed trial by extending from now", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    const lapsedEnd = new Date(Date.now() - 10 * DAY_MS);
    mocks.selectResults.push([
      {
        id: PRACTICE_ID,
        billingStatus: "trialing",
        trialEndsAt: lapsedEnd,
      },
    ]);

    const before = Date.now();
    const result = await caller().extendTrial({
      practiceId: PRACTICE_ID,
      days: 14,
    });
    const after = Date.now();

    expect(result.trialEndsAt.getTime()).toBeGreaterThanOrEqual(
      before + 14 * DAY_MS
    );
    expect(result.trialEndsAt.getTime()).toBeLessThanOrEqual(
      after + 14 * DAY_MS
    );
  });

  it("rejects non-trialing practices", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.selectResults.push([
      {
        id: PRACTICE_ID,
        billingStatus: "active",
        trialEndsAt: null,
      },
    ]);

    await expect(
      caller().extendTrial({ practiceId: PRACTICE_ID, days: 14 })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects unknown practices", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.selectResults.push([]);

    await expect(
      caller().extendTrial({ practiceId: PRACTICE_ID, days: 14 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects callers outside the platform admin allowlist", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");

    await expect(
      caller("someone@clinic.example.com").extendTrial({
        practiceId: PRACTICE_ID,
        days: 14,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
