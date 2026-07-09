import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const ROUTER_SOURCE = readFileSync(
  new URL("../routers/appointments.ts", import.meta.url),
  "utf8"
);

const { appointmentsRouter } = await import("../routers/appointments");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const TOKEN = "a".repeat(64);

function callerWithRole(db: Record<string, unknown>, role: string) {
  const session = {
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "staff@example.com",
      name: "Staff",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return appointmentsRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  selectRows?: unknown[];
  updatedRows?: unknown[];
}) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => opts?.selectRows ?? []),
      })),
    })),
  }));
  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    update,
  };
  return { db, updateSet };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("appointments calendar feed procedures", () => {
  it("returns null before the feed is turned on and the URL after", async () => {
    const off = createDb({ selectRows: [{ token: null }] });
    await expect(
      callerWithRole(off.db, "front_desk").calendarFeed()
    ).resolves.toEqual({ url: null });

    const on = createDb({ selectRows: [{ token: TOKEN }] });
    const result = await callerWithRole(on.db, "front_desk").calendarFeed();
    expect(result.url).toBe(`http://localhost:3000/api/calendar/${TOKEN}.ics`);
  });

  it("enableCalendarFeed is idempotent via COALESCE and returns the winning token", async () => {
    // The write keeps the first token ever set, so racing staff converge.
    expect(ROUTER_SOURCE).toContain(
      "calendarFeedToken: sql`coalesce(${practices.calendarFeedToken}, ${candidate})`"
    );

    const { db, updateSet } = createDb({ updatedRows: [{ token: TOKEN }] });
    const result = await callerWithRole(db, "front_desk").enableCalendarFeed();
    expect(result.url).toContain(TOKEN);
    expect(updateSet).toHaveBeenCalledTimes(1);
  });

  it("blocks viewers from enabling (global read-only guard)", async () => {
    const { db } = createDb({ updatedRows: [{ token: TOKEN }] });
    await expect(
      callerWithRole(db, "viewer").enableCalendarFeed()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps rotation admin-only", async () => {
    const { db } = createDb({ updatedRows: [{ token: TOKEN }] });
    await expect(
      callerWithRole(db, "front_desk").rotateCalendarFeed()
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const admin = createDb({ updatedRows: [{ token: TOKEN }] });
    const result = await callerWithRole(admin.db, "admin").rotateCalendarFeed();
    expect(result.url).toContain(TOKEN);
  });

  it("404s when the practice row is missing or deleted", async () => {
    const { db } = createDb({ updatedRows: [] });
    await expect(
      callerWithRole(db, "admin").enableCalendarFeed()
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const query = createDb({ selectRows: [] });
    await expect(
      callerWithRole(query.db, "admin").calendarFeed()
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
