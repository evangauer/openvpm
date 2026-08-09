import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: vi.fn(async () => undefined),
}));

const { settingsRouter } = await import("../routers/settings");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>) {
  return settingsRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function thenableRows(result: unknown[]) {
  const rows = {
    limit: vi.fn(async () => result),
    orderBy: vi.fn(async () => result),
    then: (
      resolveValue: (value: unknown[]) => unknown,
      rejectValue?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolveValue, rejectValue),
  };
  return rows;
}

function createDb(selectResults: unknown[][]) {
  const remaining = [...selectResults];
  const select = vi.fn(() => {
    const rows = thenableRows(remaining.shift() ?? []);
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => rows),
    };
    return builder;
  });
  const db: Record<string, unknown> = {
    select,
    execute: vi.fn(async () => undefined),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db, select };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings.getOnboardingState migration ledger", () => {
  it("derives durable progress from committed runs for the latest source", async () => {
    const latestAt = new Date("2026-08-08T15:00:00.000Z");
    const { db } = createDb([
      [
        {
          settings: {
            onboardingState: { migrationHasCommittedChanges: false },
          },
        },
      ],
      [
        {
          mode: "patients",
          source: "legacy_pims",
          importedCount: 0,
          reconciledCount: 0,
          committedAt: latestAt,
        },
        {
          mode: "soap_notes",
          source: "legacy_pims",
          importedCount: 3,
          reconciledCount: 0,
          committedAt: new Date("2026-08-08T14:00:00.000Z"),
        },
        {
          mode: "clients",
          source: "shepherd",
          importedCount: 8,
          reconciledCount: 1,
          committedAt: new Date("2026-08-07T14:00:00.000Z"),
        },
      ],
    ]);

    await expect(callerWithDb(db).getOnboardingState()).resolves.toMatchObject({
      migrationHasCommittedChanges: true,
      migrationLastCommittedAt: latestAt.toISOString(),
      migrationSource: "legacy_pims",
      migrationSourceHasCommittedChanges: true,
      migrationCompletedModes: ["patients", "soapNotes"],
    });
  });

  it("keeps a latest zero-change source switchable despite older material imports", async () => {
    const latestAt = new Date("2026-08-08T16:00:00.000Z");
    const { db } = createDb([
      [{ settings: { onboardingState: {} } }],
      [
        {
          mode: "clients",
          source: "legacy_pims",
          importedCount: 0,
          reconciledCount: 0,
          committedAt: latestAt,
        },
        {
          mode: "clients",
          source: "shepherd",
          importedCount: 8,
          reconciledCount: 0,
          committedAt: new Date("2026-08-07T14:00:00.000Z"),
        },
      ],
    ]);

    await expect(callerWithDb(db).getOnboardingState()).resolves.toMatchObject({
      migrationHasCommittedChanges: true,
      migrationLastCommittedAt: latestAt.toISOString(),
      migrationSource: "legacy_pims",
      migrationSourceHasCommittedChanges: false,
      migrationCompletedModes: ["clients"],
    });
  });

  it("exposes stable typed defaults and preserves the legacy marker fallback", async () => {
    const { db } = createDb([
      [
        {
          settings: {
            onboardingState: { migrationHasCommittedChanges: true },
          },
        },
      ],
      [],
    ]);

    await expect(callerWithDb(db).getOnboardingState()).resolves.toMatchObject({
      migrationHasCommittedChanges: true,
      migrationLastCommittedAt: null,
      migrationSource: null,
      migrationSourceHasCommittedChanges: false,
      migrationCompletedModes: [],
    });
  });
});
