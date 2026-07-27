import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn(async () => [{ id: "00000000-0000-0000-0000-0000000000aa" }]);
  const where = vi.fn(() => ({ returning }));
  const updateSet = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db = { update };
  return {
    db,
    update,
    updateSet,
    returning,
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn(database)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: vi.fn(
    async (
      database: unknown,
      _practiceId: string,
      fn: (tx: unknown) => Promise<unknown>
    ) => fn(database)
  ),
}));

const { adminRouter } = await import("../routers/admin");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";

function caller(email = "ops@example.com") {
  return adminRouter.createCaller({
    db: mocks.db,
    session: {
      user: {
        id: "00000000-0000-0000-0000-000000000001",
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
  mocks.returning.mockResolvedValue([{ id: PRACTICE_ID }]);
});

describe("admin analytics exclusion", () => {
  it("is restricted to platform operators", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");

    await expect(
      caller("clinic@example.com").setAnalyticsExcluded({
        practiceId: PRACTICE_ID,
        excluded: true,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reversibly marks a practice for funnel exclusion", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");

    await expect(
      caller().setAnalyticsExcluded({
        practiceId: PRACTICE_ID,
        excluded: true,
      })
    ).resolves.toEqual({ practiceId: PRACTICE_ID, excluded: true });

    expect(mocks.withSystem).toHaveBeenCalled();
    expect(mocks.updateSet).toHaveBeenCalledTimes(1);
  });

  it("reports a stale practice instead of silently succeeding", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.returning.mockResolvedValueOnce([]);

    await expect(
      caller().setAnalyticsExcluded({
        practiceId: PRACTICE_ID,
        excluded: false,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
