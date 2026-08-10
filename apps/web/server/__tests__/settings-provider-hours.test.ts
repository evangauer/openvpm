import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: vi.fn(async () => ({ status: "ok" })),
}));

const { settingsRouter } = await import("../routers/settings");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const ADMIN_ID = "00000000-0000-0000-0000-000000000001";
const PROVIDER_ID = "00000000-0000-0000-0000-000000000002";
const LOCATION_ID = "00000000-0000-0000-0000-000000000003";
const OTHER_LOCATION_ID = "00000000-0000-0000-0000-000000000004";
const SCHEDULE_ID = "00000000-0000-0000-0000-000000000006";
const OTHER_SCHEDULE_ID = "00000000-0000-0000-0000-000000000007";
const SETTINGS_SOURCE = readFileSync(
  new URL("../routers/settings.ts", import.meta.url),
  "utf8",
);

type RevisionRow = {
  id: string;
  locationId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

function revision(
  providerLocationId: string | null,
  rows: RevisionRow[],
  timezone = "America/Denver",
) {
  const schedule = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => ({
      ...row,
      startTime: row.startTime.slice(0, 5),
      endTime: row.endTime.slice(0, 5),
    }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        timezone,
        primaryLocationId: LOCATION_ID,
        providerLocationId,
        schedule,
      }),
    )
    .digest("hex");
}

const EMPTY_REVISION = revision(null, []);
const ACTIVE_LOCATIONS = [
  {
    id: LOCATION_ID,
    name: "Main Clinic",
    isPrimary: true,
    timezone: "America/Denver",
  },
  {
    id: OTHER_LOCATION_ID,
    name: "North Clinic",
    isPrimary: false,
    timezone: "America/Denver",
  },
];

function callerWithDb(
  db: Record<string, unknown>,
  role: "admin" | "front_desk" = "admin",
) {
  return settingsRouter.createCaller({
    db,
    session: {
      user: {
        id: ADMIN_ID,
        email: "admin@example.com",
        name: "Admin",
        role,
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function queryChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of [
    "from",
    "innerJoin",
    "leftJoin",
    "where",
    "orderBy",
    "limit",
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.for = vi.fn(async () => result);
  chain.then = (
    resolve: (value: unknown[]) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

function createDb(selectResults: unknown[][]) {
  const remaining = [...selectResults];
  const insertedValues: unknown[] = [];
  const updatedValues: unknown[] = [];
  const select = vi.fn(() => queryChain(remaining.shift() ?? []));
  const update = vi.fn(() => ({
    set: vi.fn((value: unknown) => {
      updatedValues.push(value);
      return { where: vi.fn(() => queryChain([])) };
    }),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn((value: unknown) => {
      insertedValues.push(value);
      return queryChain([]);
    }),
  }));
  const db: Record<string, unknown> = {
    select,
    update,
    insert,
    execute: vi.fn(async () => undefined),
  };
  db.transaction = async (run: (tx: typeof db) => unknown) => run(db);
  return { db, insertedValues, updatedValues };
}

beforeEach(() => vi.clearAllMocks());

describe("provider weekly hours", () => {
  it("keeps provider schedule reads and writes admin-only", async () => {
    const { db } = createDb([]);
    const caller = callerWithDb(db, "front_desk");

    await expect(caller.providerScheduleSetup()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.replaceProviderSchedule({
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects invalid or overlapping windows before database work", async () => {
    const { db } = createDb([]);
    const caller = callerWithDb(db);

    await expect(
      caller.replaceProviderSchedule({
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [{ dayOfWeek: 1, startTime: "18:00", endTime: "08:00" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.replaceProviderSchedule({
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [
          { dayOfWeek: 2, startTime: "08:00", endTime: "12:00" },
          { dayOfWeek: 2, startTime: "11:30", endTime: "17:00" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns normalized hours for every active clinic location", async () => {
    const rows: RevisionRow[] = [
      {
        id: SCHEDULE_ID,
        locationId: LOCATION_ID,
        dayOfWeek: 1,
        startTime: "08:00:00",
        endTime: "12:00:00",
      },
      {
        id: OTHER_SCHEDULE_ID,
        locationId: OTHER_LOCATION_ID,
        dayOfWeek: 2,
        startTime: "09:00:00",
        endTime: "16:00:00",
      },
    ];
    const { db } = createDb([
      [{ timezone: "America/Denver" }],
      ACTIVE_LOCATIONS.map(({ timezone: _timezone, ...location }) => location),
      [{ id: PROVIDER_ID, name: "Dr. Rivera", locationId: LOCATION_ID }],
      rows.map((row) => ({ ...row, userId: PROVIDER_ID })),
    ]);

    const result = await callerWithDb(db).providerScheduleSetup();

    expect(result.primaryLocation).toMatchObject({ id: LOCATION_ID });
    expect(result.locations).toHaveLength(2);
    expect(result.providers[0]).toMatchObject({
      id: PROVIDER_ID,
      unspecifiedWindowCount: 0,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      locationSchedules: [
        {
          locationId: LOCATION_ID,
          windows: [{ dayOfWeek: 1, startTime: "08:00", endTime: "12:00" }],
        },
        {
          locationId: OTHER_LOCATION_ID,
          windows: [{ dayOfWeek: 2, startTime: "09:00", endTime: "16:00" }],
        },
      ],
    });
  });

  it("replaces only the selected location and never moves the provider home base", async () => {
    const otherRow: RevisionRow = {
      id: OTHER_SCHEDULE_ID,
      locationId: OTHER_LOCATION_ID,
      dayOfWeek: 2,
      startTime: "09:00:00",
      endTime: "16:00:00",
    };
    const { db, insertedValues, updatedValues } = createDb([
      ACTIVE_LOCATIONS,
      [
        {
          id: PROVIDER_ID,
          locationId: OTHER_LOCATION_ID,
          isVeterinarian: true,
        },
      ],
      [otherRow],
    ]);

    const result = await callerWithDb(db).replaceProviderSchedule({
      userId: PROVIDER_ID,
      locationId: LOCATION_ID,
      expectedRevision: revision(OTHER_LOCATION_ID, [otherRow]),
      windows: [
        { dayOfWeek: 5, startTime: "13:00", endTime: "17:00" },
        { dayOfWeek: 1, startTime: "08:00", endTime: "12:00" },
      ],
    });

    expect(result).toEqual({
      userId: PROVIDER_ID,
      locationId: LOCATION_ID,
      windowCount: 2,
    });
    expect(updatedValues).toHaveLength(1);
    expect(updatedValues[0]).toMatchObject({ deletedAt: expect.any(Date) });
    expect(updatedValues).not.toContainEqual({ locationId: LOCATION_ID });
    expect(insertedValues[0]).toEqual([
      {
        practiceId: PRACTICE_ID,
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        dayOfWeek: 1,
        startTime: "08:00",
        endTime: "12:00",
      },
      {
        practiceId: PRACTICE_ID,
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        dayOfWeek: 5,
        startTime: "13:00",
        endTime: "17:00",
      },
    ]);
    const replaceBlock = SETTINGS_SOURCE.match(
      /replaceProviderSchedule:[\s\S]+?createUser:/,
    )?.[0];
    expect(replaceBlock).toMatch(
      /eq\(staffSchedules\.locationId, targetLocation\.id\)/,
    );
    expect(replaceBlock).not.toContain("update(users)");
  });

  it("defaults an older client without locationId to the primary clinic", async () => {
    const { db } = createDb([
      ACTIVE_LOCATIONS,
      [{ id: PROVIDER_ID, locationId: null, isVeterinarian: true }],
      [],
    ]);

    await expect(
      callerWithDb(db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [],
      }),
    ).resolves.toEqual({
      userId: PROVIDER_ID,
      locationId: LOCATION_ID,
      windowCount: 0,
    });
  });

  it("rejects a missing or inactive selected clinic location", async () => {
    const { db } = createDb([ACTIVE_LOCATIONS]);
    await expect(
      callerWithDb(db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        locationId: "00000000-0000-0000-0000-000000000099",
        expectedRevision: EMPTY_REVISION,
        windows: [],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("rejects stale editors before changing schedules", async () => {
    const currentRows: RevisionRow[] = [
      {
        id: SCHEDULE_ID,
        locationId: LOCATION_ID,
        dayOfWeek: 1,
        startTime: "08:00:00",
        endTime: "17:00:00",
      },
    ];
    const state = createDb([
      ACTIVE_LOCATIONS,
      [{ id: PROVIDER_ID, locationId: LOCATION_ID, isVeterinarian: true }],
      currentRows,
    ]);

    await expect(
      callerWithDb(state.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        expectedRevision: revision(LOCATION_ID, []),
        windows: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.updatedValues).toHaveLength(0);
  });

  it("includes timezone changes in optimistic concurrency", async () => {
    const changedTimezoneLocations = ACTIVE_LOCATIONS.map((location) => ({
      ...location,
      timezone: "America/New_York",
    }));
    const state = createDb([
      changedTimezoneLocations,
      [{ id: PROVIDER_ID, locationId: null, isVeterinarian: true }],
      [],
    ]);

    await expect(
      callerWithDb(state.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows touching windows but rejects more than three in one day", async () => {
    const valid = createDb([
      ACTIVE_LOCATIONS,
      [{ id: PROVIDER_ID, locationId: null, isVeterinarian: true }],
      [],
    ]);
    await expect(
      callerWithDb(valid.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [
          { dayOfWeek: 1, startTime: "08:00", endTime: "12:00" },
          { dayOfWeek: 1, startTime: "12:00", endTime: "17:00" },
        ],
      }),
    ).resolves.toMatchObject({ windowCount: 2 });

    const invalid = createDb([]);
    await expect(
      callerWithDb(invalid.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        locationId: LOCATION_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [
          { dayOfWeek: 1, startTime: "08:00", endTime: "09:00" },
          { dayOfWeek: 1, startTime: "10:00", endTime: "11:00" },
          { dayOfWeek: 1, startTime: "12:00", endTime: "13:00" },
          { dayOfWeek: 1, startTime: "14:00", endTime: "15:00" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
