import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearLoginAccountLock: vi.fn(async () => undefined),
  loginAccountLocks: vi.fn(async () => new Map<string, Date>()),
}));

vi.mock("@/lib/login-throttle", () => ({
  clearLoginAccountLock: mocks.clearLoginAccountLock,
  loginAccountLocks: mocks.loginAccountLocks,
}));

const { settingsRouter } = await import("../routers/settings");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const ADMIN_ID = "00000000-0000-0000-0000-000000000001";
const STAFF_ID = "00000000-0000-0000-0000-000000000002";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
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

/** Each select resolves to the next queued result, with or without `.limit()`. */
function createDb(selectResults: unknown[][]) {
  const queue = [...selectResults];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const result = queue.shift() ?? [];
        return Object.assign(Promise.resolve(result), {
          limit: vi.fn(async () => result),
        });
      }),
    })),
  }));
  const db: Record<string, unknown> = {
    select,
    execute: vi.fn(async () => undefined),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db, select };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("staff sign-in locks", () => {
  it("lets an admin clear a staff member's sign-in lock", async () => {
    const { db } = createDb([
      [{ id: PRACTICE_ID }],
      [{ id: STAFF_ID, email: "tech@example.com" }],
    ]);

    await expect(
      callerWithDb(db).clearStaffSignInLock({ id: STAFF_ID }),
    ).resolves.toEqual({ id: STAFF_ID });
    expect(mocks.clearLoginAccountLock).toHaveBeenCalledWith(
      "tech@example.com",
    );
  });

  it("is admin-only", async () => {
    for (const role of ["veterinarian", "technician", "front_desk", "viewer"]) {
      const { db, select } = createDb([]);
      await expect(
        callerWithDb(db, role).clearStaffSignInLock({ id: STAFF_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        callerWithDb(db, role).staffSignInLocks(),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(select).not.toHaveBeenCalled();
    }
    expect(mocks.clearLoginAccountLock).not.toHaveBeenCalled();
  });

  it("won't clear a lock for someone outside the practice", async () => {
    const { db } = createDb([[{ id: PRACTICE_ID }], []]);

    await expect(
      callerWithDb(db).clearStaffSignInLock({ id: STAFF_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.clearLoginAccountLock).not.toHaveBeenCalled();
  });

  it("lists only locked staff with their unlock time", async () => {
    const lockedUntil = new Date("2026-11-03T12:30:00Z");
    mocks.loginAccountLocks.mockResolvedValueOnce(
      new Map([["tech@example.com", lockedUntil]]),
    );
    const { db } = createDb([
      [{ id: PRACTICE_ID }],
      [
        { id: ADMIN_ID, email: "admin@example.com" },
        { id: STAFF_ID, email: "tech@example.com" },
      ],
    ]);

    await expect(callerWithDb(db).staffSignInLocks()).resolves.toEqual([
      { userId: STAFF_ID, lockedUntil },
    ]);
    expect(mocks.loginAccountLocks).toHaveBeenCalledWith([
      "admin@example.com",
      "tech@example.com",
    ]);
  });
});
