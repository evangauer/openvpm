import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let systemDepth = 0;
  let tenantDepth = 0;
  const events: string[] = [];
  return {
    events,
    get systemDepth() {
      return systemDepth;
    },
    get tenantDepth() {
      return tenantDepth;
    },
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        systemDepth += 1;
        events.push("system:begin");
        try {
          return await fn({ scope: "system", root: database });
        } finally {
          events.push("system:commit");
          systemDepth -= 1;
        }
      },
    ),
    withTenant: vi.fn(
      async (
        database: unknown,
        _practiceId: string,
        fn: (tx: unknown) => Promise<unknown>,
      ) => {
        tenantDepth += 1;
        events.push("tenant:begin");
        try {
          return await fn({ scope: "tenant", root: database });
        } finally {
          events.push("tenant:commit");
          tenantDepth -= 1;
        }
      },
    ),
    recordAuditLog: vi.fn(async () => undefined),
    db: {},
  };
});

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));
vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.recordAuditLog }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/auth-secret", () => ({
  hasBlankConfiguredNextAuthSecret: () => true,
}));
vi.mock("@/lib/rls-assertion", () => ({
  assertHostedRlsRoleOnce: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: () => false,
  hasHostedFullAccess: () => true,
  isEntitled: () => true,
  effectiveTier: () => "cloud",
}));
vi.mock("@openpims/db/client", () => ({ db: mocks.db }));

const { createRouter, protectedProcedure, publicProcedure } =
  await import("../trpc");

const router = createRouter({
  publicEffect: publicProcedure.mutation(({ ctx }) => {
    mocks.events.push("public:handler");
    ctx.postCommitEffect?.(async (rootDb) => {
      expect(rootDb).toBe((ctx.db as unknown as { root: unknown }).root);
      expect(mocks.systemDepth).toBe(0);
      mocks.events.push("public:effect");
    });
    return { ok: true };
  }),
  protectedEffect: protectedProcedure.mutation(({ ctx }) => {
    mocks.events.push("protected:handler");
    ctx.postCommitEffect?.(async (rootDb) => {
      expect(rootDb).toBe((ctx.db as unknown as { root: unknown }).root);
      expect(mocks.tenantDepth).toBe(0);
      mocks.events.push("protected:effect");
    });
    return { ok: true };
  }),
});

afterEach(() => {
  mocks.events.length = 0;
  vi.clearAllMocks();
});

describe("tRPC post-commit effects", () => {
  it("runs public mutation effects after the outer system transaction commits", async () => {
    const rootDb = { kind: "root-public" };
    const caller = router.createCaller({ db: rootDb, session: null } as never);

    await expect(caller.publicEffect()).resolves.toEqual({ ok: true });

    expect(mocks.events).toEqual([
      "system:begin",
      "public:handler",
      "system:commit",
      "public:effect",
    ]);
  });

  it("runs protected mutation effects after the outer tenant transaction commits", async () => {
    const rootDb = { kind: "root-tenant" };
    const caller = router.createCaller({
      db: rootDb,
      session: {
        user: {
          id: "user-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          practiceId: "practice-1",
        },
      },
    } as never);

    await expect(caller.protectedEffect()).resolves.toEqual({ ok: true });

    const commitIndex = mocks.events.indexOf("tenant:commit");
    const effectIndex = mocks.events.indexOf("protected:effect");
    expect(commitIndex).toBeGreaterThan(-1);
    expect(effectIndex).toBeGreaterThan(commitIndex);
  });
});
