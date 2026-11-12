import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  assertHostedRlsRoleOnce: vi.fn(async () => undefined),
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
  db: {
    select: vi.fn(),
  },
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("next-auth", () => ({
  getServerSession: mocks.getServerSession,
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/rls-assertion", () => ({
  assertHostedRlsRoleOnce: mocks.assertHostedRlsRoleOnce,
}));

vi.mock("@/lib/tenant-db", () => ({
  withTenant: mocks.withTenant,
  withSystem: mocks.withSystem,
}));

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { createRouter, createTRPCContext, protectedProcedure, requireRole } =
  await import("../trpc");
const { practices, users } = await import("@openpims/db");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function session(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: USER_ID,
      email: "frontdesk@example.com",
      name: "Front Desk",
      role: "front_desk",
      practiceId: PRACTICE_ID,
      sessionVersion: 1,
      ...overrides,
    },
  };
}

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    role: "front_desk",
    sessionVersion: 1,
    emailVerifiedAt: null,
    practiceCreatedAt: new Date("2026-01-01T00:00:00Z"),
    recoveryHold: false,
    ...overrides,
  };
}

const probeRouter = createRouter({
  adminOnly: protectedProcedure
    .use(requireRole("admin"))
    .query(() => "admin-ok"),
  write: protectedProcedure.mutation(() => "write-ok"),
});

async function callerFor(jwt: Record<string, unknown>, row: unknown[]) {
  mocks.getServerSession.mockResolvedValueOnce(session(jwt));
  mockActiveUserLookup(row);
  return probeRouter.createCaller(await createTRPCContext());
}

function sqlIncludesColumn(
  value: unknown,
  column: unknown,
  seen = new WeakSet<object>()
): boolean {
  if (Object.is(value, column)) {
    return true;
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => sqlIncludesColumn(item, column, seen));
  }

  const candidate = value as { queryChunks?: unknown[] };
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      sqlIncludesColumn(item, column, seen)
    );
  }

  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesColumn(item, column, seen)
  );
}

function mockActiveUserLookup(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn((_condition: unknown) => ({ limit }));
  const innerJoin = vi.fn((_table: unknown, _condition: unknown) => ({ where }));
  const from = vi.fn((_table: unknown) => ({ innerJoin }));
  mocks.db.select.mockImplementationOnce((_selection: unknown) => ({ from }));
  return { from, innerJoin, where, limit };
}

afterEach(() => {
  mocks.getServerSession.mockReset();
  mocks.db.select.mockReset();
  mocks.assertHostedRlsRoleOnce.mockClear();
  mocks.withTenant.mockClear();
  mocks.withSystem.mockClear();
  mocks.recordAuditLog.mockClear();
  vi.unstubAllEnvs();
});

describe("createTRPCContext session hardening", () => {
  it("does not ask NextAuth to decode sessions when NEXTAUTH_SECRET is blank", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "   ");

    const ctx = await createTRPCContext();

    expect(ctx.session).toBeNull();
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.assertHostedRlsRoleOnce).toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("does not revalidate when NextAuth has no session", async () => {
    mocks.getServerSession.mockResolvedValueOnce(null);

    const ctx = await createTRPCContext();

    expect(ctx.session).toBeNull();
    expect(mocks.assertHostedRlsRoleOnce).toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("keeps active sessions and verifies the user and practice inside the tenant", async () => {
    mocks.getServerSession.mockResolvedValueOnce(session());
    const lookup = mockActiveUserLookup([activeRow()]);

    const ctx = await createTRPCContext({
      req: new Request("https://app.example.test/api/trpc", {
        headers: {
          "x-forwarded-for": "203.0.113.10, 198.51.100.5",
        },
      }),
    });

    expect(ctx.session?.user.id).toBe(USER_ID);
    expect(ctx.ip).toBe("203.0.113.10");
    expect(mocks.withTenant).toHaveBeenCalledWith(
      mocks.db,
      PRACTICE_ID,
      expect.any(Function)
    );
    expect(lookup.from).toHaveBeenCalledWith(users);
    expect(lookup.innerJoin).toHaveBeenCalledWith(practices, expect.anything());

    const joinCondition = lookup.innerJoin.mock.calls[0]?.[1];
    expect(sqlIncludesColumn(joinCondition, practices.id)).toBe(true);
    expect(sqlIncludesColumn(joinCondition, users.practiceId)).toBe(true);
    expect(sqlIncludesColumn(joinCondition, practices.deletedAt)).toBe(true);

    const condition = lookup.where.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(condition, users.id)).toBe(true);
    expect(sqlIncludesColumn(condition, users.practiceId)).toBe(true);
    expect(sqlIncludesColumn(condition, users.deletedAt)).toBe(true);
  });

  it("drops stale JWT sessions when the user or practice is missing or deactivated", async () => {
    mocks.getServerSession.mockResolvedValueOnce(session());
    mockActiveUserLookup([]);

    const ctx = await createTRPCContext();

    expect(ctx.session).toBeNull();
    expect(mocks.withTenant).toHaveBeenCalledWith(
      mocks.db,
      PRACTICE_ID,
      expect.any(Function)
    );
  });

  it("reads the role and session version in the same per-request lookup", async () => {
    mocks.getServerSession.mockResolvedValueOnce(session());
    mockActiveUserLookup([activeRow()]);

    await createTRPCContext();

    expect(mocks.db.select).toHaveBeenCalledTimes(1);
    const selection = mocks.db.select.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(selection.role).toBe(users.role);
    expect(selection.sessionVersion).toBe(users.sessionVersion);
  });

  it("replaces the sign-in role snapshot with the current database role", async () => {
    mocks.getServerSession.mockResolvedValueOnce(session({ role: "admin" }));
    mockActiveUserLookup([activeRow({ role: "technician" })]);

    const ctx = await createTRPCContext();

    expect(ctx.session?.user.role).toBe("technician");
  });

  it("drops sessions whose version was bumped after they were issued", async () => {
    mocks.getServerSession.mockResolvedValueOnce(session({ sessionVersion: 1 }));
    mockActiveUserLookup([activeRow({ sessionVersion: 2 })]);

    const ctx = await createTRPCContext();

    expect(ctx.session).toBeNull();
  });

  it("keeps sessions issued before versioning while the account is unbumped", async () => {
    mocks.getServerSession.mockResolvedValueOnce(
      session({ sessionVersion: undefined }),
    );
    mockActiveUserLookup([activeRow({ sessionVersion: 1 })]);

    const ctx = await createTRPCContext();

    expect(ctx.session?.user.id).toBe(USER_ID);
  });

  it("drops sessions issued before versioning once the account was bumped", async () => {
    mocks.getServerSession.mockResolvedValueOnce(
      session({ sessionVersion: undefined }),
    );
    mockActiveUserLookup([activeRow({ sessionVersion: 2 })]);

    const ctx = await createTRPCContext();

    expect(ctx.session).toBeNull();
  });
});

describe("protected procedures enforce the current role and session", () => {
  it("refuses admin procedures to a demoted admin on the next request", async () => {
    const caller = await callerFor({ role: "admin" }, [
      activeRow({ role: "veterinarian" }),
    ]);

    await expect(caller.adminOnly()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("allows admin procedures to a promoted user before they sign in again", async () => {
    const caller = await callerFor({ role: "front_desk" }, [
      activeRow({ role: "admin" }),
    ]);

    await expect(caller.adminOnly()).resolves.toBe("admin-ok");
  });

  it("blocks writes for a user changed to viewer on the next request", async () => {
    const caller = await callerFor({ role: "admin" }, [
      activeRow({ role: "viewer" }),
    ]);

    await expect(caller.write()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Your account has read-only (viewer) access.",
    });
  });

  it("returns UNAUTHORIZED for a session revoked by a version bump", async () => {
    const caller = await callerFor({ role: "admin", sessionVersion: 3 }, [
      activeRow({ role: "admin", sessionVersion: 4 }),
    ]);

    await expect(caller.adminOnly()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.write()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("still serves sessions issued before versioning when the account is unbumped", async () => {
    const caller = await callerFor({ role: "admin", sessionVersion: undefined }, [
      activeRow({ role: "admin", sessionVersion: 1 }),
    ]);

    await expect(caller.adminOnly()).resolves.toBe("admin-ok");
  });
});
