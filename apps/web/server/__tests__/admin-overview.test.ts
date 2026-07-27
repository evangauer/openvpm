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
  const db = { select };

  return {
    db,
    selectResults,
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

function caller() {
  return adminRouter.createCaller({
    db: mocks.db,
    session: {
      user: {
        id: USER_ID,
        email: "ops@example.com",
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

describe("admin overview", () => {
  it("returns practice timezones for cross-tenant date rendering", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.com");
    mocks.selectResults.push(
      [
        {
          id: PRACTICE_ID,
          name: "Westside Vet",
          tier: "cloud",
          billingStatus: "active",
          trialEndsAt: new Date("2026-07-01T02:00:00.000Z"),
          timezone: "America/Los_Angeles",
          country: "US",
          createdAt: new Date("2026-06-01T02:00:00.000Z"),
          settings: {
            analyticsExcluded: true,
            acquisition: { source: "homepage_hero", campaign: "summer_launch" },
            onboardingState: {
              onboardingIntent: "alongside",
              journeyStepId: "data",
              journeyDismissed: true,
            },
          },
        },
      ],
      [{ practiceId: PRACTICE_ID, c: 3 }],
      [{ practiceId: PRACTICE_ID, c: 25 }],
      [{ practiceId: PRACTICE_ID, c: 40 }],
      [{ practiceId: PRACTICE_ID, c: 2 }]
    );

    const result = await caller().overview();

    expect(result.practices[0]).toMatchObject({
      id: PRACTICE_ID,
      timezone: "America/Los_Angeles",
      userCount: 3,
      locationCount: 2,
      clientCount: 25,
      patientCount: 40,
      acquisitionSource: "homepage_hero · summer_launch",
      onboardingIntent: "Alongside current PIMS",
      analyticsExcluded: true,
      setupStage: "Paused at Data import",
    });
    expect(mocks.withSystem).toHaveBeenCalledWith(
      mocks.db,
      expect.any(Function)
    );
  });
});
