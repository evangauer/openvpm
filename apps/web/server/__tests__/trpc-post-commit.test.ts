import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let systemDepth = 0;
  let tenantDepth = 0;
  const events: string[] = [];
  const executeErrors: unknown[] = [];
  const patientMergeResolverErrors: unknown[] = [];
  return {
    events,
    executeErrors,
    patientMergeResolverErrors,
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
        _options?: { isolationLevel?: "serializable" },
      ) => {
        tenantDepth += 1;
        events.push("tenant:begin");
        try {
          return await fn({
            scope: "tenant",
            root: database,
            execute: vi.fn(async () => {
              events.push("tenant:constraints");
              const error = executeErrors.shift();
              if (error) throw error;
              return [];
            }),
          });
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
  patients: createRouter({
    merge: protectedProcedure.mutation(() => {
      const error = mocks.patientMergeResolverErrors.shift();
      if (error) throw error;
      return { ok: true };
    }),
  }),
});

afterEach(() => {
  mocks.events.length = 0;
  mocks.executeErrors.length = 0;
  mocks.patientMergeResolverErrors.length = 0;
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
    expect(mocks.events.indexOf("tenant:constraints")).toBeLessThan(
      commitIndex,
    );
  });

  it("selects serializable isolation only for the patient merge path", async () => {
    const caller = router.createCaller({
      db: { kind: "root-tenant" },
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

    await expect(caller.patients.merge()).resolves.toEqual({ ok: true });

    expect(mocks.withTenant).toHaveBeenLastCalledWith(
      expect.anything(),
      "practice-1",
      expect.any(Function),
      { isolationLevel: "serializable" },
    );
  });

  it.each([
    [
      { code: "40001" },
      "CONFLICT",
      "Patient records changed during the merge. Refresh both charts and retry.",
    ],
    [
      {
        code: "23505",
        constraint_name: "patient_merge_events_operation_uq",
      },
      "CONFLICT",
      "This patient merge conflicts with another completed operation. Refresh both charts before continuing.",
    ],
    [
      {
        code: "23514",
        message:
          "A canonical patient with incoming merge history cannot be retired.",
      },
      "PRECONDITION_FAILED",
      "The patient merge no longer satisfies the identity safety checks. Refresh both charts before continuing.",
    ],
    [
      {
        code: "23503",
        message:
          "Patient merge source and target must belong to the recorded client.",
      },
      "PRECONDITION_FAILED",
      "The patient merge no longer satisfies the identity safety checks. Refresh both charts before continuing.",
    ],
  ])(
    "maps patient merge database failures to stable typed responses",
    async (error, code, message) => {
      mocks.patientMergeResolverErrors.push(error);
      const caller = router.createCaller({
        db: { kind: "root-tenant" },
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

      await expect(caller.patients.merge()).rejects.toMatchObject({
        code,
        message,
      });
    },
  );

  it("maps only the named deferred SOAP invariant and runs no audit or effect", async () => {
    mocks.executeErrors.push({
      code: "23514",
      constraint_name: "soap_notes_appointment_invariant",
    });
    const caller = router.createCaller({
      db: { kind: "root-tenant" },
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

    await expect(caller.protectedEffect()).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "Clinical documentation changed in another session. Refresh and retry.",
    });
    expect(mocks.events).not.toContain("protected:effect");
    expect(mocks.recordAuditLog).not.toHaveBeenCalled();
  });

  it("does not mislabel unrelated check violations", async () => {
    const unrelated = {
      code: "23514",
      constraint_name: "some_other_check",
    };
    mocks.executeErrors.push(unrelated);
    const caller = router.createCaller({
      db: { kind: "root-tenant" },
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

    const attempt = caller.protectedEffect();
    await expect(attempt).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    await expect(attempt).rejects.not.toMatchObject({
      code: "CONFLICT",
      message:
        "Clinical documentation changed in another session. Refresh and retry.",
    });
    expect(mocks.events).not.toContain("protected:effect");
    expect(mocks.recordAuditLog).not.toHaveBeenCalled();
  });
});
