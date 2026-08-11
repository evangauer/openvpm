import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: vi.fn(async () => ({
    status: "ok",
    message: "synced",
    updatedAt: new Date("2026-08-07T00:00:00.000Z").toISOString(),
    locationCount: 1,
    billableSeatCount: 1,
  })),
}));

const { settingsRouter } = await import("../routers/settings");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithRole(db: Record<string, unknown>, role = "admin") {
  return settingsRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: "owner@example.com",
        name: "Owner",
        role,
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function createDb(opts: { practiceRows: unknown[]; updatedRows?: unknown[] }) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => opts.practiceRows),
      })),
    })),
  }));
  const updateReturning = vi.fn(async () => opts.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const execute = vi.fn(async (_statement: unknown) => undefined);
  const db: Record<string, unknown> = {
    select,
    update,
    execute,
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);

  return { db, execute, select, updateSet };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings.requestOnboardingHelp", () => {
  it("persists an admin's request and notifies operations", async () => {
    const { db, updateSet } = createDb({
      practiceRows: [{ name: "Aspen Creek Animal Hospital", settings: {} }],
      updatedRows: [{ id: PRACTICE_ID }],
    });

    const result = await callerWithRole(db).requestOnboardingHelp();

    expect(result.requestedAt).toEqual(expect.any(String));
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Hands-on onboarding requested",
      expect.stringContaining(`practice=${PRACTICE_ID}`),
    );
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Hands-on onboarding requested",
      expect.stringContaining("requestedBy=owner@example.com"),
    );
  });

  it("returns an existing request without writing or alerting twice", async () => {
    const requestedAt = "2026-08-07T12:00:00.000Z";
    const { db, updateSet } = createDb({
      practiceRows: [
        {
          name: "Aspen Creek Animal Hospital",
          settings: { onboardingState: { setupHelpRequestedAt: requestedAt } },
        },
      ],
    });

    await expect(callerWithRole(db).requestOnboardingHelp()).resolves.toEqual({
      requestedAt,
    });
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("keeps the request admin-only", async () => {
    const { db, select, updateSet } = createDb({ practiceRows: [] });

    await expect(
      callerWithRole(db, "front_desk").requestOnboardingHelp(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("does not create a request for a missing or deleted practice", async () => {
    const { db, updateSet } = createDb({ practiceRows: [] });

    await expect(
      callerWithRole(db).requestOnboardingHelp(),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });
});

describe("settings.requestMigrationHelp", () => {
  it("persists a private migration request and routes it into setup recovery", async () => {
    const { db, execute, updateSet } = createDb({
      practiceRows: [{ name: "Aspen Creek Animal Hospital", settings: {} }],
      updatedRows: [{ id: PRACTICE_ID }],
    });

    const result = await callerWithRole(db).requestMigrationHelp({
      source: "shepherd",
    });

    expect(result).toEqual({
      requestedAt: expect.any(String),
      source: "shepherd",
    });
    expect(
      execute.mock.calls.some(([statement]) =>
        JSON.stringify(statement).includes("pg_advisory_xact_lock"),
      ),
    ).toBe(true);
    expect(JSON.stringify(execute.mock.calls)).toContain("migration-help");
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ settings: expect.anything() }),
    );
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Private migration review requested",
      expect.stringContaining("source=shepherd"),
    );
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Private migration review requested",
      expect.stringContaining("requestedBy=owner@example.com"),
    );
  });

  it("returns the durable migration request without alerting twice", async () => {
    const requestedAt = "2026-08-11T12:00:00.000Z";
    const { db, updateSet } = createDb({
      practiceRows: [
        {
          name: "Aspen Creek Animal Hospital",
          settings: {
            onboardingState: {
              migrationHelpRequestedAt: requestedAt,
              setupHelpMigrationSource: "shepherd",
            },
          },
        },
      ],
    });

    await expect(
      callerWithRole(db).requestMigrationHelp({ source: "other" }),
    ).resolves.toEqual({ requestedAt, source: "shepherd" });
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("rejects invalid source identifiers before database access", async () => {
    const { db, select, updateSet } = createDb({ practiceRows: [] });

    await expect(
      callerWithRole(db).requestMigrationHelp({ source: "bad source" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("keeps migration requests admin-only", async () => {
    const { db, select } = createDb({ practiceRows: [] });

    await expect(
      callerWithRole(db, "front_desk").requestMigrationHelp({
        source: "shepherd",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(select).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });
});
