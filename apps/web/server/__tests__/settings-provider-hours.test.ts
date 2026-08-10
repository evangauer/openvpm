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
const SECONDARY_PROVIDER_ID = "00000000-0000-0000-0000-000000000005";
const SECONDARY_SCHEDULE_ID = "00000000-0000-0000-0000-000000000008";
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

function revision(locationId: string | null, rows: RevisionRow[]) {
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
        timezone: "America/Denver",
        primaryLocationId: LOCATION_ID,
        providerLocationId: locationId,
        schedule,
      }),
    )
    .digest("hex");
}

const EMPTY_REVISION = revision(null, []);

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
      return {
        where: vi.fn(() => queryChain([])),
      };
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
        expectedRevision: EMPTY_REVISION,
        windows: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects invalid or overlapping windows before any database write", async () => {
    const { db } = createDb([]);
    const caller = callerWithDb(db);

    await expect(
      caller.replaceProviderSchedule({
        userId: PROVIDER_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [{ dayOfWeek: 1, startTime: "18:00", endTime: "08:00" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.replaceProviderSchedule({
        userId: PROVIDER_ID,
        expectedRevision: EMPTY_REVISION,
        windows: [
          { dayOfWeek: 2, startTime: "08:00", endTime: "12:00" },
          { dayOfWeek: 2, startTime: "11:30", endTime: "17:00" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns active primary-location hours normalized to HH:MM", async () => {
    const { db } = createDb([
      [{ timezone: "America/Denver" }],
      [{ id: LOCATION_ID, name: "Main Clinic" }],
      [
        { id: PROVIDER_ID, name: "Dr. Rivera", locationId: LOCATION_ID },
        {
          id: SECONDARY_PROVIDER_ID,
          name: "Dr. Secondary",
          locationId: OTHER_LOCATION_ID,
        },
      ],
      [
        {
          id: SCHEDULE_ID,
          userId: PROVIDER_ID,
          locationId: LOCATION_ID,
          dayOfWeek: 1,
          startTime: "08:00:00",
          endTime: "12:00:00",
        },
        {
          id: OTHER_SCHEDULE_ID,
          userId: PROVIDER_ID,
          locationId: LOCATION_ID,
          dayOfWeek: 1,
          startTime: "13:00:00",
          endTime: "17:30:00",
        },
        {
          id: SECONDARY_SCHEDULE_ID,
          userId: SECONDARY_PROVIDER_ID,
          locationId: OTHER_LOCATION_ID,
          dayOfWeek: 2,
          startTime: "09:00:00",
          endTime: "16:00:00",
        },
      ],
    ]);

    const result = await callerWithDb(db).providerScheduleSetup();

    expect(result.primaryLocation).toEqual({
      id: LOCATION_ID,
      name: "Main Clinic",
    });
    expect(result.providers[0]).toMatchObject({
      id: PROVIDER_ID,
      assignedToPrimary: true,
      otherLocationWindowCount: 0,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      windows: [
        { dayOfWeek: 1, startTime: "08:00", endTime: "12:00" },
        { dayOfWeek: 1, startTime: "13:00", endTime: "17:30" },
      ],
    });
    expect(result.providers[1]).toMatchObject({
      assignedToPrimary: false,
      otherLocationWindowCount: 1,
      windows: [],
    });
  });

  it("atomically replaces all active hours for the provider", async () => {
    const { db, insertedValues, updatedValues } = createDb([
      [{ id: LOCATION_ID, name: "Main Clinic", timezone: "America/Denver" }],
      [
        {
          id: PROVIDER_ID,
          locationId: LOCATION_ID,
          isVeterinarian: true,
        },
      ],
      [],
    ]);

    const result = await callerWithDb(db).replaceProviderSchedule({
      userId: PROVIDER_ID,
      expectedRevision: revision(LOCATION_ID, []),
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
      /eq\(staffSchedules\.userId, provider\.id\),\s+isNull\(staffSchedules\.deletedAt\)/,
    );
    expect(replaceBlock).not.toContain(
      "eq(staffSchedules.locationId, primaryLocation.id)",
    );
  });

  it("requires explicit confirmation before moving a provider to primary", async () => {
    const first = createDb([
      [{ id: LOCATION_ID, name: "Main Clinic", timezone: "America/Denver" }],
      [
        {
          id: PROVIDER_ID,
          locationId: OTHER_LOCATION_ID,
          isVeterinarian: true,
        },
      ],
      [],
    ]);
    await expect(
      callerWithDb(first.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        expectedRevision: revision(OTHER_LOCATION_ID, []),
        windows: [{ dayOfWeek: 1, startTime: "08:00", endTime: "17:00" }],
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(first.updatedValues).toHaveLength(0);

    const confirmed = createDb([
      [{ id: LOCATION_ID, name: "Main Clinic", timezone: "America/Denver" }],
      [
        {
          id: PROVIDER_ID,
          locationId: OTHER_LOCATION_ID,
          isVeterinarian: true,
        },
      ],
      [],
    ]);
    await callerWithDb(confirmed.db).replaceProviderSchedule({
      userId: PROVIDER_ID,
      expectedRevision: revision(OTHER_LOCATION_ID, []),
      windows: [{ dayOfWeek: 1, startTime: "08:00", endTime: "17:00" }],
      moveToPrimaryLocation: true,
    });

    expect(confirmed.updatedValues[0]).toEqual({ locationId: LOCATION_ID });
    expect(confirmed.insertedValues).toHaveLength(1);
  });

  it("does not move an unassigned or secondary provider when clearing hours", async () => {
    for (const locationId of [null, OTHER_LOCATION_ID]) {
      const state = createDb([
        [
          {
            id: LOCATION_ID,
            name: "Main Clinic",
            timezone: "America/Denver",
          },
        ],
        [
          {
            id: PROVIDER_ID,
            locationId,
            isVeterinarian: true,
          },
        ],
        [],
      ]);

      await expect(
        callerWithDb(state.db).replaceProviderSchedule({
          userId: PROVIDER_ID,
          expectedRevision: revision(locationId, []),
          windows: [],
        }),
      ).resolves.toEqual({
        userId: PROVIDER_ID,
        locationId,
        windowCount: 0,
      });

      expect(state.updatedValues).toHaveLength(1);
      expect(state.updatedValues[0]).toMatchObject({
        deletedAt: expect.any(Date),
      });
      expect(state.updatedValues).not.toContainEqual({
        locationId: LOCATION_ID,
      });
      expect(state.insertedValues).toHaveLength(0);
    }
  });

  it("requires consent before replacing hidden null or secondary-location hours", async () => {
    const hiddenRows: RevisionRow[] = [
      {
        id: OTHER_SCHEDULE_ID,
        locationId: null,
        dayOfWeek: 2,
        startTime: "09:00:00",
        endTime: "12:00:00",
      },
    ];
    const state = createDb([
      [{ id: LOCATION_ID, name: "Main Clinic", timezone: "America/Denver" }],
      [
        {
          id: PROVIDER_ID,
          locationId: LOCATION_ID,
          isVeterinarian: true,
        },
      ],
      hiddenRows,
    ]);

    await expect(
      callerWithDb(state.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        expectedRevision: revision(LOCATION_ID, hiddenRows),
        windows: [],
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("1 working window"),
    });
    expect(state.updatedValues).toHaveLength(0);
  });

  it("rejects stale editors before changing staff or schedules", async () => {
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
      [{ id: LOCATION_ID, name: "Main Clinic", timezone: "America/Denver" }],
      [
        {
          id: PROVIDER_ID,
          locationId: LOCATION_ID,
          isVeterinarian: true,
        },
      ],
      currentRows,
    ]);

    await expect(
      callerWithDb(state.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        expectedRevision: revision(LOCATION_ID, []),
        windows: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.updatedValues).toHaveLength(0);
    expect(state.insertedValues).toHaveLength(0);
  });

  it("rejects an editor opened before the practice timezone changed", async () => {
    const state = createDb([
      [
        {
          id: LOCATION_ID,
          name: "Main Clinic",
          timezone: "America/New_York",
        },
      ],
      [
        {
          id: PROVIDER_ID,
          locationId: LOCATION_ID,
          isVeterinarian: true,
        },
      ],
      [],
    ]);

    await expect(
      callerWithDb(state.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        expectedRevision: revision(LOCATION_ID, []),
        windows: [{ dayOfWeek: 1, startTime: "08:00", endTime: "17:00" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.updatedValues).toHaveLength(0);
    expect(state.insertedValues).toHaveLength(0);
  });

  it("allows touching windows but rejects more than three in one day", async () => {
    const valid = createDb([
      [{ id: LOCATION_ID, name: "Main Clinic", timezone: "America/Denver" }],
      [
        {
          id: PROVIDER_ID,
          locationId: LOCATION_ID,
          isVeterinarian: true,
        },
      ],
      [],
    ]);
    await expect(
      callerWithDb(valid.db).replaceProviderSchedule({
        userId: PROVIDER_ID,
        expectedRevision: revision(LOCATION_ID, []),
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
        expectedRevision: EMPTY_REVISION,
        windows: [
          { dayOfWeek: 1, startTime: "08:00", endTime: "09:00" },
          { dayOfWeek: 1, startTime: "10:00", endTime: "11:00" },
          { dayOfWeek: 1, startTime: "12:00", endTime: "13:00" },
          { dayOfWeek: 1, startTime: "14:00", endTime: "15:00" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(invalid.db.select).not.toHaveBeenCalled();
  });

  it("blocks provider demotion while active working hours remain", async () => {
    const { db, updatedValues } = createDb([
      [
        {
          id: PROVIDER_ID,
          role: "admin",
          isVeterinarian: true,
        },
      ],
      [],
      [{ id: "00000000-0000-0000-0000-000000000006" }],
    ]);

    await expect(
      callerWithDb(db).updateUser({
        id: PROVIDER_ID,
        isVeterinarian: false,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Clear this provider's working hours"),
    });
    expect(updatedValues).toHaveLength(0);
  });

  it("blocks the owner clinical-profile shortcut from bypassing active hours", async () => {
    const { db, updatedValues } = createDb([
      [{ id: PRACTICE_ID }],
      [
        {
          id: ADMIN_ID,
          isVeterinarian: true,
          locationId: LOCATION_ID,
        },
      ],
      [],
      [{ id: SCHEDULE_ID }],
    ]);

    await expect(
      callerWithDb(db).updateMyClinicalProfile({
        isVeterinarian: false,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Clear this provider's working hours"),
    });
    expect(updatedValues).toHaveLength(0);
  });

  it("blocks timezone changes that would reinterpret saved wall-clock hours", async () => {
    const { db, updatedValues } = createDb([
      [{ timezone: "America/Denver" }],
      [{ id: "00000000-0000-0000-0000-000000000006" }],
    ]);

    await expect(
      callerWithDb(db).updatePractice({ timezone: "America/New_York" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Clear provider working hours"),
    });
    expect(updatedValues).toHaveLength(0);
  });
});
