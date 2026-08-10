import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SETTINGS_SOURCE = readFileSync(
  new URL("../routers/settings.ts", import.meta.url),
  "utf8",
);

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: vi.fn(async () => ({
    status: "ok",
    message: "synced",
    updatedAt: new Date("2026-06-27T00:00:00Z").toISOString(),
    locationCount: 2,
    billableSeatCount: 3,
  })),
}));

const { settingsRouter } = await import("../routers/settings");
const { syncPracticeSubscriptionQuantities } =
  await import("@/lib/billing/subscription-sync");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const LOCATION_ID = "00000000-0000-0000-0000-000000000002";
const OTHER_LOCATION_ID = "00000000-0000-0000-0000-000000000003";
const ROOM_ID = "00000000-0000-0000-0000-000000000004";
const STAFF_ID = "00000000-0000-0000-0000-000000000005";
const PRODUCT_ID = "00000000-0000-0000-0000-000000000006";
const SCHEDULE_ID = "00000000-0000-0000-0000-000000000007";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      practiceId: PRACTICE_ID,
    },
  };
  return settingsRouter.createCaller({ db, session } as never);
}

function thenableRows(result: unknown[]) {
  return {
    limit: vi.fn(async () => result),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertResult?: Record<string, unknown>;
  updateReturns?: unknown[][];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const operationOrder: string[] = [];
  const select = vi.fn(() => {
    operationOrder.push("select");
    const result = selectResults.shift() ?? [];
    const afterWhere = thenableRows(result);
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
    };
    return builder;
  });

  const insertResult = opts?.insertResult ?? {
    id: LOCATION_ID,
    practiceId: PRACTICE_ID,
    name: "Downtown Clinic",
  };
  const insertValues = vi.fn(() => ({
    returning: vi.fn(async () => [insertResult]),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturns = [...(opts?.updateReturns ?? [[]])];
  const updateSet = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => updateReturns.shift() ?? []),
      then: (resolve: (value: undefined) => unknown) =>
        Promise.resolve(undefined).then(resolve),
    })),
  }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => {
      operationOrder.push("roster-lock");
    }),
    select,
    insert,
    update,
  };

  return { db, insertValues, operationOrder, updateSet };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings location workflows", () => {
  it("rejects location strings that exceed storage bounds before writes", async () => {
    const { db, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).createLocation({
        name: "A".repeat(256),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createLocation({
        name: "Downtown Clinic",
        address: "A".repeat(501),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createLocation({
        name: "Downtown Clinic",
        phone: "1".repeat(33),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateLocation({
        id: LOCATION_ID,
        name: "A".repeat(256),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).updateLocation({
        id: LOCATION_ID,
        address: "A".repeat(501),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("creates a primary location and syncs hosted billing quantities", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
    });

    await expect(
      callerWithDb(db).createLocation({
        name: "Downtown Clinic",
        address: "100 Main St",
        phone: "555-0100",
        isPrimary: true,
      }),
    ).resolves.toMatchObject({ id: LOCATION_ID, name: "Downtown Clinic" });

    expect(updateSet).toHaveBeenCalledWith({ isPrimary: false });
    expect(insertValues).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      name: "Downtown Clinic",
      address: "100 Main St",
      phone: "555-0100",
      isPrimary: true,
    });
    expect(syncPracticeSubscriptionQuantities).toHaveBeenCalledWith({
      db,
      practiceId: PRACTICE_ID,
    });
  });

  it("rejects location list and create when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], []],
    });

    await expect(callerWithDb(db).listLocations()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      callerWithDb(db).createLocation({
        name: "Downtown Clinic",
        isPrimary: true,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("requires an active practice for location reads, writes, and delete dependencies", () => {
    const locationBlock = SETTINGS_SOURCE.match(
      /\/\/ ── Locations[\s\S]+?\/\/ ── Onboarding/,
    )?.[0];

    expect(SETTINGS_SOURCE).toContain("function activePracticePredicate");
    expect(SETTINGS_SOURCE).toContain("function assertActivePractice");
    expect(locationBlock).toContain("await assertActivePractice(ctx)");
    expect(
      locationBlock?.match(/activePracticePredicate\(ctx\.practiceId\)/g)
        ?.length ?? 0,
    ).toBeGreaterThanOrEqual(10);
    expect(locationBlock).toMatch(
      /eq\(locations\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(locations\.deletedAt\)/,
    );
    expect(locationBlock).toMatch(
      /eq\(rooms\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(rooms\.deletedAt\)/,
    );
    expect(locationBlock).toMatch(
      /eq\(products\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(products\.deletedAt\)/,
    );
    expect(locationBlock).toContain(
      "eq(locationMessaging.practiceId, ctx.practiceId)",
    );
    expect(locationBlock).toContain("activePracticePredicate(ctx.practiceId)");
  });

  it("refuses to delete the only active location", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: LOCATION_ID, isPrimary: true }]],
    });

    await expect(
      callerWithDb(db).deleteLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("retires a primary location, disables its messaging setup, promotes another, and syncs billing", async () => {
    const { db, operationOrder, updateSet } = createDb({
      selectResults: [
        [
          { id: LOCATION_ID, isPrimary: true },
          { id: OTHER_LOCATION_ID, isPrimary: false },
        ],
        [],
        [],
        [],
        [],
      ],
      updateReturns: [[{ id: LOCATION_ID }], [{ id: OTHER_LOCATION_ID }]],
    });

    await expect(
      callerWithDb(db).deleteLocation({ id: LOCATION_ID }),
    ).resolves.toEqual({ success: true });

    expect(operationOrder[0]).toBe("roster-lock");
    expect(operationOrder.indexOf("select")).toBeGreaterThan(0);
    expect(updateSet).toHaveBeenCalledWith({
      deletedAt: expect.any(Date),
      isPrimary: false,
    });
    expect(updateSet).toHaveBeenCalledWith({ enabled: false });
    expect(updateSet).toHaveBeenCalledWith({ isPrimary: true });
    expect(syncPracticeSubscriptionQuantities).toHaveBeenCalledWith({
      db,
      practiceId: PRACTICE_ID,
    });
  });

  it("rejects location deletes while active rooms still use the location", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          { id: LOCATION_ID, isPrimary: false },
          { id: OTHER_LOCATION_ID, isPrimary: true },
        ],
        [{ id: ROOM_ID }],
      ],
    });

    await expect(
      callerWithDb(db).deleteLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects location deletes while active staff are assigned to the location", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          { id: LOCATION_ID, isPrimary: false },
          { id: OTHER_LOCATION_ID, isPrimary: true },
        ],
        [],
        [{ id: STAFF_ID }],
      ],
    });

    await expect(
      callerWithDb(db).deleteLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects location deletes while active inventory products use the location", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          { id: LOCATION_ID, isPrimary: false },
          { id: OTHER_LOCATION_ID, isPrimary: true },
        ],
        [],
        [],
        [{ id: PRODUCT_ID }],
      ],
    });

    await expect(
      callerWithDb(db).deleteLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects location deletes while active staff schedules use the location", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          { id: LOCATION_ID, isPrimary: false },
          { id: OTHER_LOCATION_ID, isPrimary: true },
        ],
        [],
        [],
        [],
        [{ id: SCHEDULE_ID }],
      ],
    });

    await expect(
      callerWithDb(db).deleteLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects stale location deletes before disabling messaging or syncing billing", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          { id: LOCATION_ID, isPrimary: false },
          { id: OTHER_LOCATION_ID, isPrimary: true },
        ],
        [],
        [],
        [],
        [],
      ],
      updateReturns: [[]],
    });

    await expect(
      callerWithDb(db).deleteLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({
      deletedAt: expect.any(Date),
      isPrimary: false,
    });
    expect(updateSet).not.toHaveBeenCalledWith({ enabled: false });
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("rejects primary location deletes when replacement promotion races", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          { id: LOCATION_ID, isPrimary: true },
          { id: OTHER_LOCATION_ID, isPrimary: false },
        ],
        [],
        [],
        [],
        [],
      ],
      updateReturns: [[{ id: LOCATION_ID }], []],
    });

    await expect(
      callerWithDb(db).deleteLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(updateSet).toHaveBeenCalledWith({ enabled: false });
    expect(updateSet).toHaveBeenCalledWith({ isPrimary: true });
    expect(syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
  });

  it("sets a location primary and clears other active locations", async () => {
    const { db, updateSet } = createDb({
      updateReturns: [[{ id: LOCATION_ID, isPrimary: true }]],
    });

    await expect(
      callerWithDb(db).setPrimaryLocation({ id: LOCATION_ID }),
    ).resolves.toMatchObject({ id: LOCATION_ID, isPrimary: true });

    expect(updateSet).toHaveBeenCalledWith({ isPrimary: true });
    expect(updateSet).toHaveBeenCalledWith({ isPrimary: false });
  });

  it("refuses to strand provider hours by changing the primary location", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: SCHEDULE_ID }]],
    });

    await expect(
      callerWithDb(db).setPrimaryLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Clear provider working hours"),
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale primary-location targets before clearing other primaries", async () => {
    const { db, updateSet } = createDb({ updateReturns: [[]] });

    await expect(
      callerWithDb(db).setPrimaryLocation({ id: LOCATION_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ isPrimary: true });
    expect(updateSet).not.toHaveBeenCalledWith({ isPrimary: false });
  });
});
